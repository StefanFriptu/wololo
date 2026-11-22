import { existsSync } from 'node:fs';
import type { AppContext } from '../../app/context.ts';
import type { ArrService } from '../../contracts/integrations.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { ArrInstanceInput } from '../../shared/api-types.ts';
import type { ArrInstance, ArrKind, MovieMatchCandidate } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { trimTrailingSlashes } from '../../shared/trimTrailingSlashes.ts';
import { type ArrClient, type ArrLookupMovie, createArrClient } from './arr-client.ts';
import { createArrSetup } from './arr-setup.ts';
import type { IntegrationDeps } from './IntegrationDeps.ts';
import { movieMatchScore, parseTitleYear } from './movie-match.ts';
import { isSameOrInside } from './path-map.ts';
import { pathTranslator } from './path-mapping-service.ts';
import { maskSecret, resolveSecret } from './secrets.ts';
import {
  deleteArrInstance,
  findArrInstance,
  findArrInstanceByName,
  insertArrInstance,
  listArrInstances,
  updateArrInstance,
} from './store.ts';

const INDEX_TTL_MS = 5 * 60_000;
const INDEX_MISS_REFRESH_MS = 30_000;
/** A whole library can take far longer to serialise than the interactive calls are allowed. */
const LIBRARY_TIMEOUT_MS = 120_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_FAILURE_BACKOFF_MS = 10 * 60_000;
const MAX_CACHED_SERIES = 256;
const MAX_LOOKUP_RESULTS = 20;
const TMDB_TERM = /^tmdb:\s*(\d+)$/i;

interface IndexEntry {
  itemId: number;
  folder: string;
  fileId: number | null;
  filePath: string | null;
  tmdbId: number | null;
  originalLanguage: string | null;
}

interface InstanceIndex {
  builtAt: number;
  entries: IndexEntry[];
}

interface IndexFailure {
  at: number;
  streak: number;
  error: unknown;
}

interface SeriesFiles {
  builtAt: number;
  byPath: Map<string, number>;
}

interface PathHit {
  instance: ArrInstance;
  entry: IndexEntry;
}

function masked(instance: ArrInstance): ArrInstance {
  return { ...instance, apiKey: maskSecret(instance.apiKey) };
}

/** Deepest item folder containing the path (a nested folder beats its parent). */
function owningEntry(entries: readonly IndexEntry[], localPath: string): IndexEntry | null {
  let best: IndexEntry | null = null;
  for (const entry of entries) {
    if (!isSameOrInside(localPath, entry.folder)) continue;
    if (!best || entry.folder.length > best.folder.length) best = entry;
  }
  return best;
}

function samePath(a: string, b: string): boolean {
  return isSameOrInside(a, b) && isSameOrInside(b, a);
}

export function createArrService(ctx: AppContext, deps: IntegrationDeps = {}): ArrService {
  const log = ctx.logs.logger('arr');
  const now = deps.now ?? Date.now;
  const indexes = new Map<number, InstanceIndex>();
  const building = new Map<number, Promise<InstanceIndex>>();
  const failures = new Map<number, IndexFailure>();
  const seriesFiles = new Map<string, SeriesFiles>();
  const loadingSeries = new Map<string, Promise<SeriesFiles>>();

  const libraryTimeoutMs = deps.timeoutMs ?? LIBRARY_TIMEOUT_MS;

  const clientFor = (instance: Pick<ArrInstance, 'kind' | 'url' | 'apiKey'>): ArrClient =>
    createArrClient({ ...instance, fetch: deps.fetch, timeoutMs: deps.timeoutMs });

  const requireInstance = (id: number, kind?: ArrKind): ArrInstance => {
    const instance = findArrInstance(ctx.db, id);
    if (!instance) throw notFound(`arr instance ${id}`);
    if (kind && instance.kind !== kind) {
      throw new AppError('unprocessable', `arr instance ${id} is a ${instance.kind} instance, not ${kind}`);
    }
    return instance;
  };

  const translatorFor = (instance: ArrInstance) =>
    pathTranslator(ctx.db, { scope: instance.kind, instanceId: instance.id });

  const toLocal = (instance: ArrInstance, path: string) =>
    ctx.services.pathMappings.toLocal(instance.kind, path, instance.id);

  const fetchIndex = async (instance: ArrInstance): Promise<InstanceIndex> => {
    const client = clientFor(instance);
    const entries: IndexEntry[] = [];
    if (instance.kind === 'radarr') {
      const movies = await client.movies(libraryTimeoutMs);
      const { toLocal } = translatorFor(instance);
      for (const movie of movies) {
        if (!movie.path) continue;
        entries.push({
          itemId: movie.id,
          folder: toLocal(movie.path),
          fileId: movie.movieFile?.id ?? null,
          filePath: movie.movieFile?.path ? toLocal(movie.movieFile.path) : null,
          tmdbId: movie.tmdbId ?? null,
          originalLanguage: movie.originalLanguage?.name ?? null,
        });
      }
    } else {
      const allSeries = await client.series(libraryTimeoutMs);
      const { toLocal } = translatorFor(instance);
      for (const series of allSeries) {
        if (!series.path) continue;
        entries.push({
          itemId: series.id,
          folder: toLocal(series.path),
          fileId: null,
          filePath: null,
          tmdbId: null,
          originalLanguage: series.originalLanguage?.name ?? null,
        });
      }
    }
    log.debug('arr library index refreshed', { instance: instance.name, items: entries.length });
    return { builtAt: now(), entries };
  };

  /** Concurrent callers share one in-flight build, so a large library is downloaded and parsed once at a time. */
  const buildIndex = (instance: ArrInstance): Promise<InstanceIndex> => {
    const pending = building.get(instance.id);
    if (pending) return pending;
    const current = () => building.get(instance.id) === build;
    const build: Promise<InstanceIndex> = fetchIndex(instance)
      .then(
        (index) => {
          if (current()) {
            indexes.set(instance.id, index);
            failures.delete(instance.id);
          }
          return index;
        },
        (error: unknown) => {
          if (current()) {
            const streak = (failures.get(instance.id)?.streak ?? 0) + 1;
            failures.set(instance.id, { at: now(), streak, error });
          }
          throw error;
        },
      )
      .finally(() => {
        if (current()) building.delete(instance.id);
      });
    building.set(instance.id, build);
    return build;
  };

  const forgetIndex = (id: number) => {
    indexes.delete(id);
    building.delete(id);
    failures.delete(id);
    const prefix = `${id}:`;
    for (const key of seriesFiles.keys()) if (key.startsWith(prefix)) seriesFiles.delete(key);
    for (const key of loadingSeries.keys()) if (key.startsWith(prefix)) loadingSeries.delete(key);
  };

  /** After a failed library download the instance is left alone for 1, 2, 4 ... up to 10 minutes. */
  const backingOff = (id: number): IndexFailure | null => {
    const failure = failures.get(id);
    if (!failure) return null;
    const wait = Math.min(FAILURE_BACKOFF_MS * 2 ** (failure.streak - 1), MAX_FAILURE_BACKOFF_MS);
    return now() - failure.at < wait ? failure : null;
  };

  /** A failed refresh keeps serving the previous index rather than downloading the library again for every path. */
  const indexFor = async (instance: ArrInstance): Promise<InstanceIndex> => {
    const cached = indexes.get(instance.id);
    if (cached && now() - cached.builtAt < INDEX_TTL_MS) return cached;
    const failure = backingOff(instance.id);
    if (failure) {
      if (cached) return cached;
      throw failure.error;
    }
    try {
      return await buildIndex(instance);
    } catch (error) {
      if (!cached) throw error;
      log.warn('arr library refresh failed, using the previous index', { instance: instance.name, error });
      return cached;
    }
  };

  /** A path missing from an index older than INDEX_MISS_REFRESH_MS may belong to an item added since. */
  const refreshAfterMiss = async (instance: ArrInstance): Promise<InstanceIndex | null> => {
    const cached = indexes.get(instance.id);
    if (!cached || now() - cached.builtAt < INDEX_MISS_REFRESH_MS || backingOff(instance.id)) return null;
    return buildIndex(instance);
  };

  const bestHit = async (
    instances: readonly ArrInstance[],
    localPath: string,
    indexOf: (instance: ArrInstance) => Promise<InstanceIndex | null>,
  ): Promise<PathHit | null> => {
    const settled = await Promise.allSettled(instances.map(indexOf));
    let best: PathHit | null = null;
    instances.forEach((instance, position) => {
      const result = settled[position];
      if (result?.status === 'rejected') {
        log.warn('arr lookup by path failed', { instance: instance.name, path: localPath, error: result.reason });
        return;
      }
      const index = result?.value;
      const entry = index && owningEntry(index.entries, localPath);
      if (entry && (!best || entry.folder.length > best.entry.folder.length)) best = { instance, entry };
    });
    return best;
  };

  const storeSeriesFiles = (key: string, files: SeriesFiles) => {
    seriesFiles.delete(key);
    seriesFiles.set(key, files);
    const oldest = seriesFiles.size > MAX_CACHED_SERIES ? seriesFiles.keys().next().value : undefined;
    if (oldest !== undefined) seriesFiles.delete(oldest);
  };

  /** One GET /episodefile per series, shared by every episode of it; a failure is remembered like an empty list. */
  const loadSeriesFiles = (instance: ArrInstance, seriesId: number): Promise<SeriesFiles> => {
    const key = `${instance.id}:${seriesId}`;
    const pending = loadingSeries.get(key);
    if (pending) return pending;
    const current = () => loadingSeries.get(key) === load;
    const load: Promise<SeriesFiles> = (async () => {
      const byPath = new Map<string, number>();
      const files = await clientFor(instance).episodeFiles(seriesId);
      const { toLocal } = translatorFor(instance);
      for (const file of files) {
        if (file.path) byPath.set(toLocal(file.path), file.id);
      }
      return { builtAt: now(), byPath };
    })()
      .catch((error: unknown) => {
        log.warn('sonarr episode file lookup failed', { instance: instance.name, seriesId, error });
        return { builtAt: now(), byPath: seriesFiles.get(key)?.byPath ?? new Map<string, number>() };
      })
      .then((files) => {
        if (current()) storeSeriesFiles(key, files);
        return files;
      })
      .finally(() => {
        if (current()) loadingSeries.delete(key);
      });
    loadingSeries.set(key, load);
    return load;
  };

  const fileIdFor = async (instance: ArrInstance, entry: IndexEntry, localPath: string): Promise<number | null> => {
    if (instance.kind === 'radarr') return entry.filePath === localPath ? entry.fileId : null;
    let files = seriesFiles.get(`${instance.id}:${entry.itemId}`);
    if (!files || now() - files.builtAt >= INDEX_TTL_MS) files = await loadSeriesFiles(instance, entry.itemId);
    const fileId = files.byPath.get(localPath);
    if (fileId !== undefined || now() - files.builtAt < INDEX_MISS_REFRESH_MS) return fileId ?? null;
    return (await loadSeriesFiles(instance, entry.itemId)).byPath.get(localPath) ?? null;
  };

  const validateInput = (input: ArrInstanceInput, existing: ArrInstance | null) => {
    const name = input.name.trim();
    const sameName = findArrInstanceByName(ctx.db, name);
    if (sameName && sameName.id !== existing?.id) throw new AppError('conflict', `an instance named ${name} exists`);
    if (existing && existing.kind !== input.kind) {
      throw new AppError('unprocessable', 'the kind of an existing instance cannot change');
    }
    const apiKey = resolveSecret({
      provided: input.apiKey,
      stored: existing && { secret: existing.apiKey, url: existing.url },
      url: input.url,
      label: 'API key',
    });
    if (!apiKey) throw new AppError('validation', 'apiKey is required');
    return {
      kind: input.kind,
      name,
      url: trimTrailingSlashes(input.url.trim()),
      apiKey,
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
  };

  const radarrMovieIdFor = async (
    movie: ArrLookupMovie,
    libraryIndex: () => Promise<InstanceIndex | null>,
  ): Promise<number | null> => {
    if (movie.id != null && movie.id > 0) return movie.id;
    const index = await libraryIndex();
    return index?.entries.find((entry) => entry.tmdbId === movie.tmdbId)?.itemId ?? null;
  };

  return {
    list: async () => listArrInstances(ctx.db).map(masked),
    get: async (id) => masked(requireInstance(id)),
    create: async (input) => {
      const created = insertArrInstance(ctx.db, validateInput(input, null));
      log.info('arr instance added', { id: created.id, kind: created.kind, name: created.name });
      return masked(created);
    },
    update: async (id, input) => {
      const existing = requireInstance(id);
      const updated = updateArrInstance(ctx.db, { id, values: validateInput(input, existing) });
      forgetIndex(id);
      return masked(updated);
    },
    remove: async (id) => {
      if (!deleteArrInstance(ctx.db, id)) throw notFound(`arr instance ${id}`);
      forgetIndex(id);
      log.info('arr instance removed', { id });
    },
    test: async (input) => {
      const stored = input.id == null ? null : requireInstance(input.id);
      try {
        const apiKey = resolveSecret({
          provided: input.apiKey,
          stored: stored && { secret: stored.apiKey, url: stored.url },
          url: input.url,
          label: 'API key',
        });
        if (!apiKey) return { ok: false, message: 'API key is required', version: null };
        const client = clientFor({ kind: input.kind, url: input.url, apiKey });
        const status = await client.systemStatus();
        const appName = status.appName ?? client.service;
        if (appName.toLowerCase() !== input.kind) {
          return { ok: false, message: `this is ${appName}, not ${client.service}`, version: status.version };
        }
        return { ok: true, message: `Connected to ${appName} ${status.version}`, version: status.version };
      } catch (error) {
        return { ok: false, message: errorMessage(error), version: null };
      }
    },
    rootFolders: async (id) => {
      const instance = requireInstance(id);
      const folders = await clientFor(instance).rootFolders();
      return Promise.all(
        folders.map(async (folder) => {
          const localPath = await toLocal(instance, folder.path);
          return {
            id: folder.id,
            path: folder.path,
            localPath,
            accessible: existsSync(localPath),
            freeBytes: folder.freeSpace ?? null,
          };
        }),
      );
    },
    qualityProfiles: async (id) => clientFor(requireInstance(id)).qualityProfiles(),
    lookupMovie: async (instanceId, term, year) => {
      const instance = requireInstance(instanceId, 'radarr');
      const client = clientFor(instance);
      const tmdb = TMDB_TERM.exec(term.trim());
      const wanted = parseTitleYear(term, year ?? null);
      const results = tmdb
        ? [await client.lookupTmdb(Number(tmdb[1]))]
        : await client.lookupMovies(wanted.year ? `${wanted.title} (${wanted.year})` : wanted.title);
      let library: Promise<InstanceIndex | null> | null = null;
      const libraryIndex = () =>
        (library ??= indexFor(instance).catch((error: unknown) => {
          log.warn('could not read the Radarr library for a lookup', { instance: instance.name, error });
          return null;
        }));
      const candidates: MovieMatchCandidate[] = [];
      for (const movie of results) {
        if (movie.tmdbId <= 0) continue;
        candidates.push({
          title: movie.title,
          year: movie.year ?? null,
          tmdbId: movie.tmdbId,
          imdbId: movie.imdbId ?? null,
          score: tmdb ? 1 : movieMatchScore(wanted, { ...movie, year: movie.year ?? null }),
          radarrMovieId: await radarrMovieIdFor(movie, libraryIndex),
        });
      }
      return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_LOOKUP_RESULTS);
    },
    addMovie: async (instanceId, movie) => {
      const instance = requireInstance(instanceId, 'radarr');
      const client = clientFor(instance);
      const qualityProfileId = movie.qualityProfileId ?? (await client.qualityProfiles())[0]?.id;
      if (qualityProfileId == null) throw new AppError('unprocessable', `${instance.name} has no quality profile`);
      const rootFolderPath = await ctx.services.pathMappings.toRemote('radarr', movie.rootFolderPath, instanceId);
      const id = await client.addMovie({
        title: movie.title,
        tmdbId: movie.tmdbId,
        year: movie.year,
        qualityProfileId,
        rootFolderPath,
      });
      forgetIndex(instanceId);
      log.info('movie added to Radarr', { instance: instance.name, movieId: id, tmdbId: movie.tmdbId });
      return id;
    },
    findByPath: async (localPath) => {
      const instances = listArrInstances(ctx.db).filter((instance) => instance.enabled);
      const best =
        (await bestHit(instances, localPath, indexFor)) ?? (await bestHit(instances, localPath, refreshAfterMiss));
      if (!best) return null;
      const { instance, entry } = best;
      return {
        ref: {
          instanceId: instance.id,
          kind: instance.kind,
          itemId: entry.itemId,
          fileId: await fileIdFor(instance, entry, localPath),
        },
        originalLanguage: normalizeLanguage(entry.originalLanguage),
      };
    },
    rescan: async (ref) => {
      const instance = requireInstance(ref.instanceId, ref.kind);
      const command =
        ref.kind === 'radarr'
          ? ({ name: 'RescanMovie', movieId: ref.itemId } as const)
          : ({ name: 'RescanSeries', seriesId: ref.itemId } as const);
      await clientFor(instance).command(command);
      log.info('rescan requested', { instance: instance.name, command: command.name, itemId: ref.itemId });
    },
    importMovieFolder: async (instanceId, localPath, movieId) => {
      const instance = requireInstance(instanceId, 'radarr');
      const client = clientFor(instance);
      const path = await ctx.services.pathMappings.toRemote('radarr', localPath, instanceId);
      const movie = await client.movie(movieId);
      if (movie.path && samePath(movie.path, path)) {
        await client.command({ name: 'RescanMovie', movieId });
        log.info('Radarr rescan of the movie folder requested', { instance: instance.name, movieId, path });
        return;
      }
      await client.command({ name: 'DownloadedMoviesScan', path });
      log.info('Radarr import requested', { instance: instance.name, movieId, path });
    },
    defaultRadarr: async () => {
      const first = listArrInstances(ctx.db).find((instance) => instance.kind === 'radarr' && instance.enabled);
      return first ? masked(first) : null;
    },
    ...createArrSetup(ctx, { requireInstance, clientFor, libraryTimeoutMs }),
  };
}
