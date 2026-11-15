import { and, eq, ne } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import { mediaFiles } from '../../db/schema.ts';
import type { MediaFileDetail } from '../../shared/api-types.ts';
import { MEDIA_FILE_STATUSES, type MediaFileStatus } from '../../shared/domain.ts';
import { statEntry } from './entries.ts';
import { summarizeProbe } from './evaluation.ts';
import { libraryQuery } from './libraryQuery.ts';
import { createMediaEngine } from './mediaEngine.ts';
import {
  jobsForMediaQuery,
  listMediaQuery,
  type MediaSummaryRow,
  mediaDetailQuery,
  mediaStatsQuery,
  toSummary,
} from './mediaQuery.ts';

export function createMediaService(ctx: AppContext): MediaService {
  const log = ctx.logs.logger('media');
  const engine = createMediaEngine(ctx);

  const libraryOf = (id: number) => {
    const [library] = libraryQuery(ctx.db, { id });
    if (!library) throw notFound(`library ${id}`);
    return library;
  };

  const service: MediaService = {
    list: async (query) => {
      const { total, rows } = listMediaQuery(ctx.db, query);
      return { page: query.page ?? 1, pageSize: query.pageSize ?? 50, total, items: rows.map(toSummary) };
    },

    get: async (id): Promise<MediaFileDetail> => {
      const row = mediaDetailQuery(ctx.db, { id });
      if (!row) throw notFound(`media file ${id}`);
      const arr =
        row.arrInstanceId !== null && row.arrKind !== null && row.arrItemId !== null
          ? { instanceId: row.arrInstanceId, kind: row.arrKind, itemId: row.arrItemId, fileId: row.arrFileId }
          : null;
      return {
        ...toSummary(row as MediaSummaryRow),
        probe: row.probe,
        plan: row.plan,
        rulesKey: row.rulesKey,
        originalLanguage: row.originalLanguage,
        arr,
        jobs: jobsForMediaQuery(ctx.db, id),
      };
    },

    stats: async (libraryId) => {
      const stats = mediaStatsQuery(ctx.db, libraryId);
      const byStatus = Object.fromEntries(MEDIA_FILE_STATUSES.map((status) => [status, 0])) as Record<
        MediaFileStatus,
        number
      >;
      for (const row of stats.byStatus) byStatus[row.status] = row.count;
      return { total: stats.total, totalBytes: stats.totalBytes, byStatus, byFailingCodec: stats.byFailingCodec };
    },

    findByPath: async (path) => {
      const row = mediaDetailQuery(ctx.db, { path });
      return row ? toSummary(row as MediaSummaryRow) : null;
    },

    checkPath: async (path, refs) => (await engine.evaluatePath(path, refs)).result,

    reprobe: async (id) => {
      const row = engine.rowById(id);
      await engine.evaluatePath(row.path, { trigger: 'manual' }, { forceProbe: true, force: true, enqueue: false });
      return service.get(id);
    },

    previewPlan: async (id) => {
      const row = engine.rowById(id);
      if (row.kind !== 'file') {
        if (row.plan) return row.plan;
        throw new AppError('unprocessable', 'disc plans come from the disc analysis (GET /api/v1/bdmv/discs/:id)');
      }
      const probe = row.probe ?? (await ctx.services.probe.probe(row.path));
      const library = libraryOf(row.libraryId);
      const { profile } = await engine.rulesFor(library);
      return ctx.services.rules.plan({ probe, profile, library, originalLanguage: row.originalLanguage });
    },

    setIgnored: async (id, ignored, reason) => {
      const row = engine.rowById(id);
      if (row.status === 'processing') throw new AppError('conflict', 'a job is processing this file');
      if (ignored) {
        engine.update(id, { status: 'ignored', statusReason: reason ?? 'ignored by user' });
        return engine.summaryOf(id);
      }
      if (row.status !== 'ignored') return engine.summaryOf(id);
      engine.update(id, { status: 'pending', statusReason: reason ?? null });
      await engine.evaluatePath(row.path, { trigger: 'manual' }, { enqueue: false });
      return engine.summaryOf(id);
    },

    setStatus: async (id, status, reason) => {
      engine.rowById(id);
      engine.update(id, { status, statusReason: reason });
    },

    recordJobResult: async (id, result) => {
      const row = engine.rowById(id);
      const path = result.path ?? row.path;
      if (path !== row.path) {
        const stale = ctx.db
          .select({ id: mediaFiles.id })
          .from(mediaFiles)
          .where(and(eq(mediaFiles.path, path), ne(mediaFiles.id, id)))
          .get();
        if (stale) engine.deleteRows([stale.id]);
      }
      const entry = await statEntry(path);
      const values: Partial<typeof mediaFiles.$inferInsert> = {
        path,
        status: result.status,
        statusReason: result.reason,
        lastJobId: result.lastJobId,
        ...(entry ? { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, kind: entry.kind } : {}),
      };
      if (result.probe) {
        const probe = result.probe;
        Object.assign(values, {
          probe,
          probedAt: probe.probedAt,
          durationSec: probe.durationSec,
          formatName: probe.formatName,
          ...summarizeProbe(probe),
        });
        try {
          const library = libraryOf(row.libraryId);
          const rules = await engine.rulesFor(library);
          const plan = ctx.services.rules.plan({
            probe,
            profile: rules.profile,
            library,
            originalLanguage: row.originalLanguage,
          });
          Object.assign(values, {
            plan,
            planAction: plan.action,
            failingCodecs: plan.failingCodecs,
            rulesKey: rules.rulesKey,
          });
        } catch (error) {
          log.error('could not re-plan after a job', { mediaFileId: id, error: errorMessage(error) });
          Object.assign(values, { rulesKey: null });
        }
      }
      engine.update(id, values);
    },

    invalidateRules: async (filter) => {
      let total = 0;
      for (const library of engine.librariesForProfile(filter.profileId, filter.libraryId))
        total += await engine.invalidateLibrary(library);
      if (total > 0) log.info('files marked for re-check', { ...filter, count: total });
      return total;
    },
  };
  return service;
}
