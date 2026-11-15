import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { DownloadClientService } from '../../contracts/integrations.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import type { DownloadClientInput } from '../../shared/api-types.ts';
import type { DownloadClientConnection, TorrentInfo } from '../../shared/domain.ts';
import type { IntegrationDeps } from './arr-service.ts';
import { createQbittorrentClient, type QbittorrentClient } from './qbittorrent-client.ts';
import { maskSecret, resolveSecret } from './secrets.ts';
import { mediaFilesWithCompletedJob, mediaFilesWithin, replacedOriginalPaths } from './seeding-query.ts';
import { deleteDownloadClient, getDownloadClient, saveDownloadClient } from './store.ts';
import { matchTorrent, toTorrentInfo } from './torrent.ts';

function masked(connection: DownloadClientConnection): DownloadClientConnection {
  return { ...connection, password: maskSecret(connection.password) };
}

async function inodeKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

/** Media files of a torrent's local content (the path itself when it is a file). */
async function contentFiles(path: string, extensions: readonly string[]): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name).toLowerCase()))
    .map((entry) => join(entry.parentPath, entry.name));
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

  const withLocalPaths = async (torrent: TorrentInfo): Promise<TorrentInfo> => ({
    ...torrent,
    savePath: await ctx.services.pathMappings.toLocal('qbittorrent', torrent.savePath),
    contentPath: await ctx.services.pathMappings.toLocal('qbittorrent', torrent.contentPath),
  });

  const torrentsOf = async (connection: DownloadClientConnection): Promise<TorrentInfo[]> =>
    (await clientFor(connection).torrents(connection.category)).map(toTorrentInfo);

  const resolveInput = (input: DownloadClientInput): DownloadClientConnection => {
    const password = resolveSecret(input.password, getDownloadClient(ctx.db)?.password) ?? '';
    return { ...input, url: input.url.trim().replace(/\/+$/, ''), password };
  };

  const replacedInodes = async (): Promise<Set<string>> => {
    const keys = await Promise.all(replacedOriginalPaths(ctx.db).map(inodeKey));
    return new Set(keys.filter((key): key is string => key != null));
  };

  /** True when the torrent still holds an original that an audio job replaced (its files share an inode with a bin entry). */
  const holdsReplacedOriginal = async (localContent: string, inodes: ReadonlySet<string>): Promise<boolean> => {
    if (inodes.size === 0) return false;
    for (const file of await contentFiles(localContent, ctx.settings.section('media').extensions)) {
      const key = await inodeKey(file);
      if (key && inodes.has(key)) return true;
    }
    return false;
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
      log.info('download client saved', { url: saved.url, enabled: saved.enabled });
      return masked(saved);
    },
    remove: async () => {
      deleteDownloadClient(ctx.db);
      cached = null;
    },
    test: async (input) => {
      const connection = resolveInput(input);
      try {
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
      const remotePath = await ctx.services.pathMappings.toRemote('qbittorrent', localPath);
      const match = matchTorrent(await torrentsOf(connection), remotePath);
      return match ? withLocalPaths(match) : null;
    },
    deleteTorrent,
    checkSeedingGoals: async () => {
      const connection = active();
      if (!connection) return 'no download client configured';
      const met = (await torrentsOf(connection)).filter((torrent) => torrent.goalMet);
      if (met.length === 0) return 'no torrent has met its seeding goal';
      const offerDiscs = ctx.settings.section('bdmv').deleteSourceWhenSeeded;
      const inodes = connection.removeWhenGoalMet ? await replacedInodes() : new Set<string>();
      let removed = 0;
      let offered = 0;
      for (const remote of met) {
        const torrent = await withLocalPaths(remote);
        try {
          const rows = mediaFilesWithin(ctx.db, torrent.contentPath);
          const discs = rows.filter((row) => row.kind !== 'file');
          const converted = mediaFilesWithCompletedJob(ctx.db, { ids: discs.map((row) => row.id), type: 'bdmv' });
          if (offerDiscs) {
            for (const disc of discs.filter((row) => converted.has(row.id))) {
              if (await ctx.services.bdmv.offerSourceDeletion(disc.id, torrent)) offered += 1;
            }
          }
          if (rows.length > 0 || !connection.removeWhenGoalMet) continue;
          if (!(await holdsReplacedOriginal(torrent.contentPath, inodes))) continue;
          await deleteTorrent(torrent.hash, true);
          removed += 1;
        } catch (error) {
          log.error('seeding check failed for a torrent', { hash: torrent.hash, name: torrent.name, error });
        }
      }
      return `${met.length} torrent(s) met their seeding goal: ${removed} removed, ${offered} source deletion(s) offered`;
    },
  };
}
