import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { RecycleBinService } from '../../contracts/jobs.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { RecycleBinRow } from '../../db/schema.ts';
import type { RecycleBinEntry } from '../../shared/domain.ts';
import { toRecycleBinEntry } from '../jobs/mappers.ts';
import { removeEmptyRecycleDirs } from './cleanup.ts';
import { binRootFor, expiresAtFor, recyclePathFor, recycleStamp } from './paths.ts';
import {
  getRecycleRow,
  insertRecycleRow,
  linkJobToRecycleRow,
  listActiveRecycleRows,
  markRecycleRow,
  purgeableRecycleRows,
  recyclePathTaken,
} from './recycleBinQueries.ts';

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

type Refs = { jobId?: number | null; mediaFileId?: number | null };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

export function createRecycleBinService(ctx: AppContext): RecycleBinService {
  const log = ctx.logs.logger('recycle-bin');
  const { db } = ctx;

  const history = async (entry: Parameters<AppContext['services']['jobs']['addHistory']>[0]) => {
    try {
      await ctx.services.jobs.addHistory(entry);
    } catch (error) {
      log.warn('cannot write recycle-bin history', { path: entry.path, error: errorMessage(error) });
    }
  };

  const libraryRoot = async (path: string): Promise<string | null> => {
    try {
      return (await ctx.services.libraries.findRootForPath(path))?.rootPath ?? null;
    } catch (error) {
      log.warn('cannot resolve the library root, using a bin next to the file', { path, error: errorMessage(error) });
      return null;
    }
  };

  /** Picks a free bin path on the same filesystem as path and creates its folder. */
  const prepareTarget = async (path: string): Promise<string> => {
    const rootPath = await libraryRoot(path);
    const binRoot = binRootFor({ configuredPath: ctx.settings.section('recycleBin').path, rootPath, path });
    const stamp = recycleStamp(new Date());
    let target = recyclePathFor({ binRoot, rootPath, originalPath: path, stamp });
    for (let attempt = 1; existsSync(target) || recyclePathTaken(db, target); attempt++)
      target = recyclePathFor({ binRoot, rootPath, originalPath: path, stamp, attempt });
    mkdirSync(dirname(target), { recursive: true });
    if (statSync(dirname(target)).dev !== statSync(path).dev)
      throw new AppError('precondition_failed', `recycle bin ${binRoot} is on another filesystem than ${path}`);
    return target;
  };

  const record = async (path: string, target: string, refs: Refs, mode: 'link' | 'move'): Promise<RecycleBinRow> => {
    const stats = statSync(target);
    const now = new Date();
    const row = insertRecycleRow(db, {
      originalPath: path,
      recyclePath: target,
      sizeBytes: stats.size,
      uid: stats.uid,
      gid: stats.gid,
      mode: stats.mode & 0o7777,
      jobId: refs.jobId ?? null,
      mediaFileId: refs.mediaFileId ?? null,
      expiresAt: expiresAtFor(now, ctx.settings.section('recycleBin').retentionDays),
    });
    await history({
      event: 'recycled',
      path,
      message: `${mode === 'link' ? 'linked' : 'moved'} to ${target}`,
      jobId: refs.jobId ?? null,
      mediaFileId: refs.mediaFileId ?? null,
      data: { recycleBinEntryId: row.id },
    });
    return row;
  };

  const recycle = async (path: string, refs: Refs): Promise<RecycleBinEntry> => {
    if (!existsSync(path)) throw notFound(path);
    const target = await prepareTarget(path);
    renameSync(path, target);
    return toRecycleBinEntry(await record(path, target, refs, 'move'));
  };

  const mustGetActive = (id: number): RecycleBinRow => {
    const row = getRecycleRow(db, id);
    if (!row) throw notFound(`recycle bin entry ${id}`);
    if (row.restoredAt) throw new AppError('conflict', `recycle bin entry ${id} was already restored`);
    if (row.purgedAt) throw new AppError('conflict', `recycle bin entry ${id} was already deleted`);
    return row;
  };

  const deleteFile = (row: RecycleBinRow): boolean => {
    if (!existsSync(row.recyclePath)) return false;
    unlinkSync(row.recyclePath);
    removeEmptyRecycleDirs(row.recyclePath);
    return true;
  };

  const restoreOwnership = (row: RecycleBinRow) => {
    try {
      if (row.mode !== null) chmodSync(row.originalPath, row.mode);
      if (row.uid !== null && row.gid !== null) chownSync(row.originalPath, row.uid, row.gid);
    } catch (error) {
      log.warn('restored file keeps its current owner', { path: row.originalPath, error: errorMessage(error) });
    }
  };

  const currentMediaPath = async (mediaFileId: number | null): Promise<string | null> => {
    if (mediaFileId === null) return null;
    try {
      return (await ctx.services.media.get(mediaFileId)).path;
    } catch (error) {
      log.warn('cannot read the media file of a restored entry', { mediaFileId, error: errorMessage(error) });
      return null;
    }
  };

  return {
    list: async (query) => {
      const page = Math.max(1, query.page ?? 1);
      const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
      const { rows, total } = listActiveRecycleRows(db, { page, pageSize, sortDir: query.sortDir ?? 'desc' });
      return { page, pageSize, total, items: rows.map(toRecycleBinEntry) };
    },

    recycle,

    recycleForReplace: async (path, refs) => {
      if (!existsSync(path)) throw notFound(path);
      const target = await prepareTarget(path);
      let mode: 'link' | 'move' = 'link';
      try {
        linkSync(path, target);
      } catch (error) {
        if (!LINK_UNSUPPORTED.has(errorCode(error) ?? '')) throw error;
        log.warn('hard links unsupported here, moving the original into the bin', { path, error: errorMessage(error) });
        renameSync(path, target);
        mode = 'move';
      }
      const row = await record(path, target, refs, mode);
      linkJobToRecycleRow(db, refs.jobId, row.id);
      return { entry: toRecycleBinEntry(row), mode };
    },

    restore: async (id) => {
      const row = mustGetActive(id);
      if (!existsSync(row.recyclePath))
        throw new AppError('conflict', `the recycled file is missing: ${row.recyclePath}`);
      const refs = { jobId: row.jobId, mediaFileId: row.mediaFileId };
      const converted = await currentMediaPath(row.mediaFileId);
      if (converted && converted !== row.originalPath && existsSync(converted)) await recycle(converted, refs);
      if (existsSync(row.originalPath)) await recycle(row.originalPath, refs);
      renameSync(row.recyclePath, row.originalPath);
      removeEmptyRecycleDirs(row.recyclePath);
      restoreOwnership(row);
      const restored = markRecycleRow(db, id, { restoredAt: new Date().toISOString() });
      if (row.mediaFileId !== null) {
        try {
          await ctx.services.media.setIgnored(row.mediaFileId, true, 'restored from recycle bin');
        } catch (error) {
          log.warn('cannot mark the restored file as ignored', {
            mediaFileId: row.mediaFileId,
            error: errorMessage(error),
          });
        }
      }
      try {
        await ctx.services.notifier.fileChanged({
          kind: 'replaced',
          localPath: row.originalPath,
          mediaFileId: row.mediaFileId,
          arr: null,
          jobId: row.jobId,
        });
      } catch (error) {
        log.warn('notifying about a restored file failed', { path: row.originalPath, error: errorMessage(error) });
      }
      await history({
        event: 'restored',
        path: row.originalPath,
        message: `restored from ${row.recyclePath}`,
        jobId: row.jobId,
        mediaFileId: row.mediaFileId,
        data: { recycleBinEntryId: id },
      });
      return toRecycleBinEntry(restored);
    },

    remove: async (id) => {
      const row = mustGetActive(id);
      deleteFile(row);
      markRecycleRow(db, id, { purgedAt: new Date().toISOString() });
      await history({
        event: 'purged',
        path: row.originalPath,
        message: `deleted ${row.recyclePath}`,
        jobId: row.jobId,
        mediaFileId: row.mediaFileId,
        data: { recycleBinEntryId: id },
      });
    },

    purge: async (options) => {
      const nowIso = new Date().toISOString();
      let purged = 0;
      let freedBytes = 0;
      for (const row of purgeableRecycleRows(db, { all: options.all === true, nowIso })) {
        try {
          if (deleteFile(row)) freedBytes += row.sizeBytes;
          markRecycleRow(db, row.id, { purgedAt: nowIso });
          purged += 1;
          await history({
            event: 'purged',
            path: row.originalPath,
            message: options.all ? 'recycle bin emptied' : 'retention period over',
            jobId: row.jobId,
            mediaFileId: row.mediaFileId,
            data: { recycleBinEntryId: row.id },
          });
        } catch (error) {
          log.error('cannot purge recycle bin entry', {
            id: row.id,
            path: row.recyclePath,
            error: errorMessage(error),
          });
        }
      }
      return { purged, freedBytes };
    },
  };
}
