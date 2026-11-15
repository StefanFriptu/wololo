import { existsSync } from 'node:fs';
import type { AppContext } from '../../app/context.ts';
import type { ArrService } from '../../contracts/integrations.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { ArrInstanceInput } from '../../shared/api-types.ts';
import type { ArrInstance, ArrKind, MovieMatchCandidate } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { type ArrClient, type ArrLookupMovie, createArrClient } from './arr-client.ts';
import { movieMatchScore, parseTitleYear } from './movie-match.ts';
import { isSameOrInside } from './path-map.ts';
import { maskSecret, resolveSecret } from './secrets.ts';
import {
  deleteArrInstance,
  findArrInstance,
  findArrInstanceByName,
  insertArrInstance,
  listArrInstances,
  updateArrInstance,
} from './store.ts';
import type { FetchLike } from './upstream.ts';

const INDEX_TTL_MS = 5 * 60_000;
const INDEX_MISS_REFRESH_MS = 30_000;
const MAX_LOOKUP_RESULTS = 20;
const TMDB_TERM = /^tmdb:\s*(\d+)$/i;

export interface IntegrationDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

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

export function createArrService(ctx: AppContext, deps: IntegrationDeps = {}): ArrService {
  const log = ctx.logs.logger('arr');
  const now = deps.now ?? Date.now;
  const indexes = new Map<number, InstanceIndex>();

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

  const toLocal = (instance: ArrInstance, path: string) =>
    ctx.services.pathMappings.toLocal(instance.kind, path, instance.id);

  const buildIndex = async (instance: ArrInstance): Promise<InstanceIndex> => {
    const client = clientFor(instance);
    const entries: IndexEntry[] = [];
    if (instance.kind === 'radarr') {
      for (const movie of await client.movies()) {
        if (!movie.path) continue;
        entries.push({
          itemId: movie.id,
          folder: await toLocal(instance, movie.path),
          fileId: movie.movieFile?.id ?? null,
          filePath: movie.movieFile?.path ? await toLocal(instance, movie.movieFile.path) : null,
          tmdbId: movie.tmdbId ?? null,
          originalLanguage: movie.originalLanguage?.name ?? null,
        });
      }
    } else {
      for (const series of await client.series()) {
        if (!series.path) continue;
        entries.push({
          itemId: series.id,
          folder: await toLocal(instance, series.path),
          fileId: null,
          filePath: null,
          tmdbId: null,
          originalLanguage: series.originalLanguage?.name ?? null,
        });
      }
    }
    const index = { builtAt: now(), entries };
    indexes.set(instance.id, index);
    log.debug('arr library index refreshed', { instance: instance.name, items: entries.length });
    return index;
  };

  const indexFor = async (instance: ArrInstance): Promise<InstanceIndex> => {
    const cached = indexes.get(instance.id);
    if (cached && now() - cached.builtAt < INDEX_TTL_MS) return cached;
    return buildIndex(instance);
  };

  const findInInstance = async (instance: ArrInstance, localPath: string): Promise<IndexEntry | null> => {
    const index = await indexFor(instance);
    const hit = owningEntry(index.entries, localPath);
    if (hit || now() - index.builtAt < INDEX_MISS_REFRESH_MS) return hit;
    return owningEntry((await buildIndex(instance)).entries, localPath);
  };

  const fileIdFor = async (instance: ArrInstance, entry: IndexEntry, localPath: string): Promise<number | null> => {
    if (instance.kind === 'radarr') return entry.filePath === localPath ? entry.fileId : null;
    try {
      for (const file of await clientFor(instance).episodeFiles(entry.itemId)) {
        if (file.path && (await toLocal(instance, file.path)) === localPath) return file.id;
      }
    } catch (error) {
      log.warn('sonarr episode file lookup failed', { instance: instance.name, error });
    }
    return null;
  };

  const validateInput = (input: ArrInstanceInput, existing: ArrInstance | null) => {
    const name = input.name.trim();
    const sameName = findArrInstanceByName(ctx.db, name);
    if (sameName && sameName.id !== existing?.id) throw new AppError('conflict', `an instance named ${name} exists`);
    if (existing && existing.kind !== input.kind) {
      throw new AppError('unprocessable', 'the kind of an existing instance cannot change');
    }
    const apiKey = resolveSecret(input.apiKey, existing?.apiKey);
    if (!apiKey) throw new AppError('validation', 'apiKey is required');
    return {
      kind: input.kind,
      name,
      url: input.url.trim().replace(/\/+$/, ''),
      apiKey,
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
  };

  const radarrMovieIdFor = async (instance: ArrInstance, movie: ArrLookupMovie): Promise<number | null> => {
    if (movie.id != null && movie.id > 0) return movie.id;
    const index = await indexFor(instance).catch((error: unknown) => {
      log.warn('could not read the Radarr library for a lookup', { instance: instance.name, error });
      return null;
    });
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
      indexes.delete(id);
      return masked(updated);
    },
    remove: async (id) => {
      if (!deleteArrInstance(ctx.db, id)) throw notFound(`arr instance ${id}`);
      indexes.delete(id);
      log.info('arr instance removed', { id });
    },
    test: async (input) => {
      const stored = input.id == null ? null : requireInstance(input.id);
      const apiKey = resolveSecret(input.apiKey, stored?.apiKey);
      if (!apiKey) return { ok: false, message: 'API key is required', version: null };
      const client = clientFor({ kind: input.kind, url: input.url, apiKey });
      try {
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
      const candidates: MovieMatchCandidate[] = [];
      for (const movie of results) {
        if (movie.tmdbId <= 0) continue;
        candidates.push({
          title: movie.title,
          year: movie.year ?? null,
          tmdbId: movie.tmdbId,
          imdbId: movie.imdbId ?? null,
          score: tmdb ? 1 : movieMatchScore(wanted, { ...movie, year: movie.year ?? null }),
          radarrMovieId: await radarrMovieIdFor(instance, movie),
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
      indexes.delete(instanceId);
      log.info('movie added to Radarr', { instance: instance.name, movieId: id, tmdbId: movie.tmdbId });
      return id;
    },
    findByPath: async (localPath) => {
      const instances = listArrInstances(ctx.db).filter((instance) => instance.enabled);
      let best: { instance: ArrInstance; entry: IndexEntry } | null = null;
      for (const instance of instances) {
        try {
          const entry = await findInInstance(instance, localPath);
          if (entry && (!best || entry.folder.length > best.entry.folder.length)) best = { instance, entry };
        } catch (error) {
          log.warn('arr lookup by path failed', { instance: instance.name, path: localPath, error });
        }
      }
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
    importMovieFolder: async (instanceId, localPath) => {
      const instance = requireInstance(instanceId, 'radarr');
      const path = await ctx.services.pathMappings.toRemote('radarr', localPath, instanceId);
      await clientFor(instance).command({ name: 'DownloadedMoviesScan', path });
      log.info('Radarr import requested', { instance: instance.name, path });
    },
    defaultRadarr: async () => {
      const first = listArrInstances(ctx.db).find((instance) => instance.kind === 'radarr' && instance.enabled);
      return first ? masked(first) : null;
    },
  };
}
