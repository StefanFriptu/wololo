import { stat } from 'node:fs/promises';
import { extname, posix } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { DownloadClientService } from '../../contracts/integrations.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { TorrentRemovalRow } from '../../db/schema.ts';
import type { DownloadClientInput } from '../../shared/api-types.ts';
import type { ArrInstance, DownloadClientConnection, TorrentInfo } from '../../shared/domain.ts';
import { trimTrailingSlashes } from '../../shared/trimTrailingSlashes.ts';
import { type ArrClient, createArrClient } from './arr-client.ts';
import type { IntegrationDeps } from './IntegrationDeps.ts';
import { isSameOrInside, joinRemotePath } from './path-map.ts';
import { type PathTranslator, pathTranslator } from './path-mapping-service.ts';
import { createQbittorrentClient, type QbittorrentClient } from './qbittorrent-client.ts';
import { redactUrl } from './redact-url.ts';
import { maskSecret, resolveSecret } from './secrets.ts';
import {
  audioJobSourcePaths,
  libraryCopiesAt,
  mediaFilesWithCompletedJob,
  mediaFilesWithin,
  pathsReplacedByAudioJob,
  replacedOriginals,
  restoredSince,
} from './seeding-query.ts';
import {
  deleteDownloadClient,
  findArrInstance,
  getDownloadClient,
  listArrInstances,
  saveDownloadClient,
} from './store.ts';
import {
  matchTorrent,
  type TorrentFileCopy,
  type TorrentMediaFile,
  torrentContentReplaced,
  torrentConversionProgress,
  toTorrentInfo,
} from './torrent.ts';
import {
  finishTorrentRemoval,
  getTorrentRemoval,
  hasPendingTorrentRemoval,
  keepTorrentRemovalPending,
  pendingTorrentRemovals,
  requestTorrentRemoval,
  toTorrentRemoval,
} from './torrent-removal-queries.ts';

const REMOVAL_BATCH = 50;

interface ArrSource {
  instance: ArrInstance;
  client: ArrClient;
  paths: PathTranslator;
}

function masked(connection: DownloadClientConnection): DownloadClientConnection {
  return { ...connection, password: maskSecret(connection.password) };
}

async function fileInfo(path: string): Promise<{ key: string; isFile: boolean } | null> {
  try {
    const info = await stat(path, { bigint: true });
    return { key: `${info.dev}:${info.ino}`, isFile: info.isFile() };
  } catch {
    return null;
  }
}

export function createDownloadClientService(ctx: AppContext, deps: IntegrationDeps = {}): DownloadClientService {
  const log = ctx.logs.logger('downloadclient');
  let cached: { key: string; client: QbittorrentClient } | null = null;

  const clientFor = (connection: DownloadClientConnection): QbittorrentClient => {
    const key = JSON.stringify([connection.url, connection.username, connection.password]);
    if (cached?.key === key) return cached.client;
    const client = createQbittorrentClient({ ...connection, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
    cached = { key, client };
    return client;
  };

  const active = (): DownloadClientConnection | null => {
    const connection = getDownloadClient(ctx.db);
    return connection?.enabled ? connection : null;
  };

  const qbittorrentPaths = () => pathTranslator(ctx.db, { scope: 'qbittorrent', instanceId: null });

  const withLocalPaths = (torrent: TorrentInfo, paths: PathTranslator): TorrentInfo => ({
    ...torrent,
    savePath: paths.toLocal(torrent.savePath),
    contentPath: paths.toLocal(torrent.contentPath),
  });

  const torrentsOf = async (connection: DownloadClientConnection): Promise<TorrentInfo[]> =>
    (await clientFor(connection).torrents(connection.category)).map(toTorrentInfo);

  const resolveInput = (input: DownloadClientInput): DownloadClientConnection => {
    const stored = getDownloadClient(ctx.db);
    const password = resolveSecret({
      provided: input.password,
      stored: stored && { secret: stored.password, url: stored.url },
      url: input.url,
      label: 'password',
    });
    return { ...input, url: trimTrailingSlashes(input.url.trim()), password: password ?? '' };
  };

  /** Inode key of each replaced original in the recycle bin -> its media file. */
  const replacedOriginalKeys = async (): Promise<Map<string, number | null>> => {
    const originals = replacedOriginals(ctx.db);
    const infos = await Promise.all(originals.map((original) => fileInfo(original.recyclePath)));
    const keys = new Map<string, number | null>();
    originals.forEach((original, position) => {
      const info = infos[position];
      if (info) keys.set(info.key, original.mediaFileId);
    });
    return keys;
  };

  /** The torrent's own files (qBittorrent's file list), as local paths; never its neighbours in a shared folder. */
  const localFilesOf = async (
    connection: DownloadClientConnection,
    remote: TorrentInfo,
    paths: PathTranslator,
  ): Promise<string[]> => {
    const names = await clientFor(connection).files(remote.hash);
    return names.map((name) => posix.normalize(paths.toLocal(joinRemotePath(remote.savePath, name))));
  };

  const arrSources = (): ArrSource[] =>
    listArrInstances(ctx.db)
      .filter((instance) => instance.enabled)
      .map((instance) => ({
        instance,
        client: createArrClient({ ...instance, fetch: deps.fetch, timeoutMs: deps.timeoutMs }),
        paths: pathTranslator(ctx.db, { scope: instance.kind, instanceId: instance.id }),
      }));

  /** Radarr/Sonarr import history of a download: local dropped path -> local imported library path. */
  const importsOf = async (hash: string, sources: readonly ArrSource[]): Promise<Map<string, string>> => {
    const settled = await Promise.allSettled(
      sources.map(async ({ client, paths }) =>
        (await client.imports(hash)).map(
          (record) =>
            [
              posix.normalize(paths.toLocal(record.droppedPath)),
              posix.normalize(paths.toLocal(record.importedPath)),
            ] as const,
        ),
      ),
    );
    const imports = new Map<string, string>();
    sources.forEach(({ instance }, position) => {
      const result = settled[position];
      if (result?.status === 'rejected') {
        log.warn('import history unavailable; relying on the recycle bin', {
          instance: instance.name,
          hash,
          error: result.reason,
        });
        return;
      }
      for (const [dropped, imported] of result?.value ?? []) imports.set(dropped, imported);
    });
    return imports;
  };

  /** The torrent's media files (by the library extensions) that exist as regular files, with their inode key. */
  const mediaFilesIn = async (files: readonly string[]): Promise<{ path: string; key: string }[]> => {
    const extensions = ctx.settings.section('media').extensions;
    const found: { path: string; key: string }[] = [];
    for (const path of files) {
      if (!extensions.includes(extname(path).toLowerCase())) continue;
      const info = await fileInfo(path);
      if (info?.isFile) found.push({ path, key: info.key });
    }
    return found;
  };

  /** True when every media file of the torrent has a library copy and at least one was replaced by an audio job. */
  const contentReplaced = async ({
    files,
    hash,
    bin,
    sources,
  }: {
    files: readonly string[];
    hash: string;
    bin: ReadonlyMap<string, number | null>;
    sources: readonly ArrSource[];
  }) => {
    const imports = await importsOf(hash, sources);
    const media: TorrentMediaFile[] = (await mediaFilesIn(files)).map((file) => ({
      path: file.path,
      inRecycleBin: bin.has(file.key),
      importedTo: imports.get(file.path) ?? null,
    }));
    const importedTo = media.flatMap((file) => (file.importedTo ? [file.importedTo] : []));
    return torrentContentReplaced(media, pathsReplacedByAudioJob(ctx.db, importedTo));
  };

  /** Each media file of the torrent with its library copy, and the media files those copies are. */
  const copiesOf = async (
    hash: string,
    localFiles: readonly string[],
    sources: readonly ArrSource[],
  ): Promise<{ copies: TorrentFileCopy[]; mediaFileIds: number[] }> => {
    const files = await mediaFilesIn(localFiles);
    const [imports, bin] = await Promise.all([importsOf(hash, sources), replacedOriginalKeys()]);
    const rows = libraryCopiesAt(
      ctx.db,
      files.flatMap((file) => imports.get(file.path) ?? []),
    );
    const rowOf = (path: string) => {
      const imported = imports.get(path);
      return imported ? rows.get(imported) : undefined;
    };
    const ids = [...rows.values()].map((row) => row.id);
    const converted = mediaFilesWithCompletedJob(ctx.db, { ids, type: 'audio' });
    const binIds = files.flatMap((file) => bin.get(file.key) ?? []);
    return {
      copies: files.map((file) => {
        const row = rowOf(file.path);
        return {
          path: file.path,
          status: row?.status ?? null,
          converted: bin.has(file.key) || (row != null && converted.has(row.id)),
        };
      }),
      mediaFileIds: [...new Set([...ids, ...binIds])],
    };
  };

  const deleteTorrent = async (hash: string, deleteFiles: boolean) => {
    const connection = active();
    if (!connection) throw new AppError('precondition_failed', 'no download client configured');
    await clientFor(connection).deleteTorrent(hash, deleteFiles);
    log.info('torrent removed from qBittorrent', { hash, deleteFiles });
  };

  const seedingGoals = async (): Promise<string> => {
    const connection = active();
    if (!connection) return 'no download client configured';
    const met = (await torrentsOf(connection)).filter((torrent) => torrent.goalMet);
    if (met.length === 0) return 'no torrent has met its seeding goal';
    const offerDiscs = ctx.settings.section('bdmv').deleteSourceWhenSeeded;
    const summary = (removed: number, offered: number) =>
      `${met.length} torrent(s) met their seeding goal: ${removed} removed, ${offered} source deletion(s) offered`;
    if (!offerDiscs && !connection.removeWhenGoalMet) return summary(0, 0);
    const bin = connection.removeWhenGoalMet ? await replacedOriginalKeys() : new Map<string, number | null>();
    let removed = 0;
    let offered = 0;
    const paths = qbittorrentPaths();
    const sources = arrSources();
    for (const remote of met) {
      const torrent = withLocalPaths(remote, paths);
      try {
        const files = await localFilesOf(connection, remote, paths);
        const owns = (rowPath: string) => files.some((file) => isSameOrInside(file, rowPath));
        const rows = mediaFilesWithin(ctx.db, torrent.contentPath).filter((row) => owns(row.path));
        const discs = rows.filter((row) => row.kind !== 'file');
        const converted = mediaFilesWithCompletedJob(ctx.db, { ids: discs.map((row) => row.id), type: 'bdmv' });
        if (offerDiscs) {
          for (const disc of discs.filter((row) => converted.has(row.id))) {
            if (await ctx.services.bdmv.offerSourceDeletion(disc.id, torrent)) offered += 1;
          }
        }
        if (rows.length > 0 || !connection.removeWhenGoalMet) continue;
        if (!(await contentReplaced({ files, hash: remote.hash, bin, sources }))) continue;
        await deleteTorrent(torrent.hash, true);
        removed += 1;
      } catch (error) {
        log.error('seeding check failed for a torrent', { hash: torrent.hash, name: torrent.name, error });
      }
    }
    return summary(removed, offered);
  };

  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();

  /** The qBittorrent torrent (remote paths) a library file was imported from, per its Radarr/Sonarr item history. */
  const locate = async (
    mediaFileId: number,
  ): Promise<{ connection: DownloadClientConnection; remote: TorrentInfo } | null> => {
    const connection = active();
    if (!connection) return null;
    const media = await ctx.services.media.get(mediaFileId);
    const ref = media.arr ?? (await ctx.services.arr.findByPath(media.path))?.ref ?? null;
    if (!ref) return null;
    const instance = findArrInstance(ctx.db, ref.instanceId);
    if (!instance?.enabled) return null;
    const client = createArrClient({ ...instance, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
    const arrPaths = pathTranslator(ctx.db, { scope: instance.kind, instanceId: instance.id });
    const libraryPaths = new Set([media.path, ...audioJobSourcePaths(ctx.db, mediaFileId)]);
    const hashes = (await client.itemImports(ref.itemId))
      .filter((record) => libraryPaths.has(posix.normalize(arrPaths.toLocal(record.importedPath))))
      .map((record) => record.downloadId.toLowerCase());
    if (hashes.length === 0) return null;
    const torrents = await torrentsOf(connection);
    for (const hash of hashes) {
      const remote = torrents.find((torrent) => torrent.hash.toLowerCase() === hash);
      if (remote) return { connection, remote };
    }
    return null;
  };

  type Verdict = { action: 'remove' } | { action: 'keep' | 'cancel'; reason: string };

  const judge = async (
    connection: DownloadClientConnection,
    remote: TorrentInfo,
    request: TorrentRemovalRow,
    sources: readonly ArrSource[],
  ): Promise<Verdict> => {
    const paths = qbittorrentPaths();
    const files = await localFilesOf(connection, remote, paths);
    const { copies, mediaFileIds } = await copiesOf(remote.hash, files, sources);
    if (restoredSince(ctx.db, mediaFileIds, request.createdAt))
      return { action: 'cancel', reason: 'a file of this torrent was restored from the recycle bin' };
    const owns = (rowPath: string) => files.some((file) => isSameOrInside(file, rowPath));
    const contentPath = withLocalPaths(remote, paths).contentPath;
    if (mediaFilesWithin(ctx.db, contentPath).some((row) => owns(row.path)))
      return { action: 'keep', reason: 'a library file lives inside this torrent' };
    const progress = torrentConversionProgress(copies);
    if (progress.unaccounted.length > 0)
      return { action: 'keep', reason: `${progress.unaccounted.length} file(s) are not in the library` };
    if (!progress.allConverted)
      return { action: 'keep', reason: `${progress.done} of ${progress.total} file(s) converted` };
    if (request.condition === 'converted_and_seeded' && !remote.goalMet)
      return { action: 'keep', reason: 'waiting for the seeding goal' };
    return { action: 'remove' };
  };

  const runRemovals = async (): Promise<string> => {
    const pending = pendingTorrentRemovals(ctx.db, REMOVAL_BATCH);
    if (pending.length === 0) return 'no torrent removal pending';
    const connection = active();
    if (!connection) return `${pending.length} torrent removal(s) wait for a download client`;
    const torrents = await torrentsOf(connection);
    const sources = arrSources();
    let removed = 0;
    for (const request of pending) {
      const remote = torrents.find((torrent) => torrent.hash.toLowerCase() === request.hash);
      if (!remote) {
        finishTorrentRemoval(ctx.db, request.hash, { state: 'missing', reason: 'no longer in qBittorrent' }, nowIso());
        continue;
      }
      try {
        const verdict = await judge(connection, remote, request, sources);
        if (verdict.action === 'keep') {
          keepTorrentRemovalPending(ctx.db, request, verdict.reason);
          continue;
        }
        if (verdict.action === 'cancel') {
          finishTorrentRemoval(ctx.db, request.hash, { state: 'cancelled', reason: verdict.reason }, nowIso());
          log.info('torrent removal cancelled', { hash: request.hash, name: request.name, reason: verdict.reason });
          continue;
        }
        await deleteTorrent(remote.hash, true);
        finishTorrentRemoval(ctx.db, request.hash, { state: 'removed', reason: null }, nowIso());
        removed += 1;
      } catch (error) {
        log.error('torrent removal check failed', { hash: request.hash, name: request.name, error });
        keepTorrentRemovalPending(ctx.db, request, errorMessage(error));
      }
    }
    return `${pending.length} torrent removal(s) checked: ${removed} removed`;
  };

  let running: Promise<string> | null = null;
  let again = false;
  const processRemovals = (): Promise<string> => {
    if (running) {
      again = true;
      return running;
    }
    const run = async () => {
      try {
        let summary: string;
        do {
          again = false;
          summary = await runRemovals();
        } while (again);
        return summary;
      } finally {
        running = null;
      }
    };
    running = run();
    return running;
  };

  ctx.events.on('job.finished', ({ job, state }) => {
    if (state !== 'completed' || job.type !== 'audio' || !hasPendingTorrentRemoval(ctx.db)) return;
    processRemovals().catch((error) => log.error('torrent removals failed', { error }));
  });

  return {
    get: async () => {
      const connection = getDownloadClient(ctx.db);
      return connection ? masked(connection) : null;
    },
    save: async (input) => {
      const saved = saveDownloadClient(ctx.db, resolveInput(input));
      cached = null;
      log.info('download client saved', { url: redactUrl(saved.url), enabled: saved.enabled });
      return masked(saved);
    },
    remove: async () => {
      deleteDownloadClient(ctx.db);
      cached = null;
    },
    test: async (input) => {
      try {
        const connection = resolveInput(input);
        const version = await createQbittorrentClient({
          ...connection,
          fetch: deps.fetch,
          timeoutMs: deps.timeoutMs,
        }).version();
        return { ok: true, message: `Connected to qBittorrent ${version}`, version };
      } catch (error) {
        return { ok: false, message: errorMessage(error), version: null };
      }
    },
    findTorrentByPath: async (localPath) => {
      const connection = active();
      if (!connection) return null;
      const paths = qbittorrentPaths();
      const match = matchTorrent(await torrentsOf(connection), paths.toRemote(localPath));
      return match ? withLocalPaths(match, paths) : null;
    },
    deleteTorrent,
    checkSeedingGoals: async () => {
      const goals = await seedingGoals();
      return hasPendingTorrentRemoval(ctx.db) ? `${goals}; ${await processRemovals()}` : goals;
    },
    torrentForMedia: async (mediaFileId) => {
      const found = await locate(mediaFileId);
      if (!found) return null;
      const { connection, remote } = found;
      const files = await localFilesOf(connection, remote, qbittorrentPaths());
      const progress = torrentConversionProgress((await copiesOf(remote.hash, files, arrSources())).copies);
      const row = getTorrentRemoval(ctx.db, remote.hash.toLowerCase());
      return {
        hash: remote.hash.toLowerCase(),
        name: remote.name,
        goalMet: remote.goalMet,
        total: progress.total,
        done: progress.done,
        unaccounted: [...progress.unaccounted],
        allConverted: progress.allConverted,
        removal: row ? toTorrentRemoval(row) : null,
      };
    },
    requestRemoval: async (mediaFileId, condition) => {
      const found = await locate(mediaFileId);
      if (!found) throw notFound(`a qBittorrent torrent for media file ${mediaFileId}`);
      const { remote } = found;
      const row = requestTorrentRemoval(
        ctx.db,
        { hash: remote.hash.toLowerCase(), name: remote.name, condition },
        nowIso(),
      );
      log.info('torrent removal requested', { hash: row.hash, name: row.name, condition });
      processRemovals().catch((error) => log.error('torrent removals failed', { error }));
      return toTorrentRemoval(row);
    },
    cancelRemoval: async (mediaFileId) => {
      const found = await locate(mediaFileId);
      if (!found) return;
      const hash = found.remote.hash.toLowerCase();
      if (finishTorrentRemoval(ctx.db, hash, { state: 'cancelled', reason: 'kept' }, nowIso()))
        log.info('torrent removal cancelled', { hash, name: found.remote.name, reason: 'kept' });
    },
    processRemovals,
  };
}
