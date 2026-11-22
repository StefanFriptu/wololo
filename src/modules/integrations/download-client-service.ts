import { stat } from 'node:fs/promises';
import { extname, posix } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { DownloadClientService } from '../../contracts/integrations.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import type { DownloadClientInput } from '../../shared/api-types.ts';
import type { DownloadClientConnection, TorrentInfo } from '../../shared/domain.ts';
import { trimTrailingSlashes } from '../../shared/trimTrailingSlashes.ts';
import { createArrClient } from './arr-client.ts';
import type { IntegrationDeps } from './arr-service.ts';
import { isSameOrInside, joinRemotePath } from './path-map.ts';
import { type PathTranslator, pathTranslator } from './path-mapping-service.ts';
import { createQbittorrentClient, type QbittorrentClient } from './qbittorrent-client.ts';
import { redactUrl } from './redact-url.ts';
import { maskSecret, resolveSecret } from './secrets.ts';
import {
  mediaFilesWithCompletedJob,
  mediaFilesWithin,
  pathsReplacedByAudioJob,
  replacedOriginalPaths,
} from './seeding-query.ts';
import { deleteDownloadClient, getDownloadClient, listArrInstances, saveDownloadClient } from './store.ts';
import { matchTorrent, type TorrentMediaFile, torrentContentReplaced, toTorrentInfo } from './torrent.ts';

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

  const replacedInodes = async (): Promise<Set<string>> => {
    const infos = await Promise.all(replacedOriginalPaths(ctx.db).map(fileInfo));
    return new Set(infos.flatMap((info) => (info ? [info.key] : [])));
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

  /** Radarr/Sonarr import history of a download: local dropped path -> local imported library path. */
  const importsOf = async (hash: string): Promise<Map<string, string>> => {
    const imports = new Map<string, string>();
    for (const instance of listArrInstances(ctx.db).filter((candidate) => candidate.enabled)) {
      try {
        const client = createArrClient({ ...instance, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
        const records = await client.imports(hash);
        const { toLocal } = pathTranslator(ctx.db, { scope: instance.kind, instanceId: instance.id });
        for (const record of records) {
          imports.set(posix.normalize(toLocal(record.droppedPath)), posix.normalize(toLocal(record.importedPath)));
        }
      } catch (error) {
        log.warn('import history unavailable; relying on the recycle bin', { instance: instance.name, hash, error });
      }
    }
    return imports;
  };

  /** True when every media file of the torrent has a library copy and at least one was replaced by an audio job. */
  const contentReplaced = async (files: readonly string[], hash: string, bin: ReadonlySet<string>) => {
    const extensions = ctx.settings.section('media').extensions;
    const imports = await importsOf(hash);
    const media: TorrentMediaFile[] = [];
    for (const path of files) {
      if (!extensions.includes(extname(path).toLowerCase())) continue;
      const info = await fileInfo(path);
      if (!info?.isFile) continue;
      media.push({ path, inRecycleBin: bin.has(info.key), importedTo: imports.get(path) ?? null });
    }
    const importedTo = media.flatMap((file) => (file.importedTo ? [file.importedTo] : []));
    return torrentContentReplaced(media, pathsReplacedByAudioJob(ctx.db, importedTo));
  };

  const deleteTorrent = async (hash: string, deleteFiles: boolean) => {
    const connection = active();
    if (!connection) throw new AppError('precondition_failed', 'no download client configured');
    await clientFor(connection).deleteTorrent(hash, deleteFiles);
    log.info('torrent removed from qBittorrent', { hash, deleteFiles });
  };

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
      const connection = active();
      if (!connection) return 'no download client configured';
      const met = (await torrentsOf(connection)).filter((torrent) => torrent.goalMet);
      if (met.length === 0) return 'no torrent has met its seeding goal';
      const offerDiscs = ctx.settings.section('bdmv').deleteSourceWhenSeeded;
      const summary = (removed: number, offered: number) =>
        `${met.length} torrent(s) met their seeding goal: ${removed} removed, ${offered} source deletion(s) offered`;
      if (!offerDiscs && !connection.removeWhenGoalMet) return summary(0, 0);
      const bin = connection.removeWhenGoalMet ? await replacedInodes() : new Set<string>();
      let removed = 0;
      let offered = 0;
      const paths = qbittorrentPaths();
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
          if (!(await contentReplaced(files, remote.hash, bin))) continue;
          await deleteTorrent(torrent.hash, true);
          removed += 1;
        } catch (error) {
          log.error('seeding check failed for a torrent', { hash: torrent.hash, name: torrent.name, error });
        }
      }
      return summary(removed, offered);
    },
  };
}
