import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { JobsService, NewJob } from '../../contracts/jobs.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import { yieldToEventLoop } from '../../core/yieldToEventLoop.ts';
import type { JobRow } from '../../db/schema.ts';
import type { EnqueueRequest, EnqueueResponse, MediaFileSummary, PageQuery } from '../../shared/api-types.ts';
import { JOB_STATES, type JobState, type JobSummary } from '../../shared/domain.ts';
import { checkRecycleBinLocation, NODE_BIN_TRIAL_FS } from '../recycle-bin/checkRecycleBinLocation.ts';
import { createAudioExecutor } from './audioExecutor.ts';
import {
  deleteHistoryRows,
  deleteJobRow,
  deleteJobRows,
  existingJobIds,
  expiredHistoryIdsQuery,
  findActiveJobForMedia,
  finishedJobIdsBefore,
  getJobRow,
  idleJobsWithTempPath,
  insertJobRow,
  isTempPathReferenced,
  jobsInState,
  listHistoryRows,
  listJobRows,
  type PageWindow,
  prunableJobIdsQuery,
  queueRows,
  runningAudioJobsBefore,
  updateJobRow,
} from './jobQueries.ts';
import { createJobLifecycle } from './lifecycle.ts';
import { toHistoryEntry, toJobDetail, toJobSummary } from './mappers.ts';
import { jobLogPathFor, jobTitleFor, outputPathFor } from './paths.ts';
import { readLogChunk } from './readLogChunk.ts';
import { deleteTempPath, resolveInterruptedJob } from './recover.ts';
import { sweepOrphanedTempPaths } from './sweepOrphanedTempPaths.ts';
import { createWorker } from './worker.ts';

const ENQUEUE_PAGE_SIZE = 500;
const ENQUEUE_SLICE = 50;
const QUEUE_ITEMS_LIMIT = 500;
const JOB_LOG_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const JOB_LOG_NAME = /^(\d+)\.txt$/;
const LOG_TAIL_BYTES = 256 * 1024;

function pageWindow(query: PageQuery): PageWindow {
  return {
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.min(500, Math.max(1, query.pageSize ?? 50)),
    sortDir: query.sortDir ?? 'desc',
  };
}

function parseStates(value: string | undefined): JobState[] | undefined {
  if (!value) return undefined;
  const states = value.split(',').map((state) => state.trim());
  return states.filter((state): state is JobState => (JOB_STATES as readonly string[]).includes(state));
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

export function createJobsService(ctx: AppContext): JobsService {
  const log = ctx.logs.logger('jobs');
  const { db } = ctx;
  const lifecycle = createJobLifecycle(ctx, { log, onChange: () => worker.wake() });
  const audioExecutor = createAudioExecutor({
    services: ctx.services,
    ffmpegPath: () => ctx.config.get().tools.ffmpeg,
    recycleBinEnabled: () => ctx.settings.section('recycleBin').enabled,
    checkRecycleBin: async (path) => {
      await checkRecycleBinLocation(
        {
          configuredPath: ctx.settings.section('recycleBin').path,
          findRootForPath: (target) => ctx.services.libraries.findRootForPath(target),
          warn: (message, context) => log.warn(message, context),
          trialFs: NODE_BIN_TRIAL_FS,
        },
        path,
      );
    },
    runningJobForOutput: (jobId, outputPath) =>
      runningAudioJobsBefore(db, jobId).find((row) => outputPathFor(row.sourcePath) === outputPath)?.id ?? null,
    recordPlan: (jobId, plan, before) => {
      updateJobRow(db, jobId, {
        plan,
        beforeStreams: before,
        rulesKey: plan.rulesKey,
        lostFeatures: plan.lostFeatures,
      });
    },
    log,
  });
  const worker = createWorker({
    ctx,
    log,
    lifecycle,
    executorFor: (type) => (type === 'audio' ? audioExecutor : ctx.services.bdmv.execute),
  });

  const summary = (row: JobRow): JobSummary => toJobSummary(row, worker.live(row.id));
  const mustGet = (id: number): JobRow => {
    const row = getJobRow(db, id);
    if (!row) throw notFound(`job ${id}`);
    return row;
  };
  const logPathOf = (row: JobRow): string | null =>
    row.logPath === null ? null : jobLogPathFor(ctx.config.get().jobLogDir, row.id);

  const enqueue = async (job: NewJob): Promise<JobSummary> => {
    const existing = findActiveJobForMedia(db, job.mediaFileId);
    if (existing) return summary(existing);
    const media = await ctx.services.media.get(job.mediaFileId);
    const raced = findActiveJobForMedia(db, job.mediaFileId);
    if (raced) return summary(raced);
    const row = insertJobRow(db, {
      type: job.type,
      trigger: job.trigger,
      mediaFileId: job.mediaFileId,
      libraryId: media.libraryId,
      priority: job.priority ?? 0,
      title: job.title ?? jobTitleFor(media.path, media.kind),
      sourcePath: media.path,
      plan: job.plan ?? null,
      bdmvPlan: job.bdmvPlan ?? null,
      rulesKey: job.plan?.rulesKey ?? null,
      lostFeatures: job.plan?.lostFeatures ?? [],
      bytesBefore: media.sizeBytes,
    });
    lifecycle.addHistory({
      event: 'queued',
      path: row.sourcePath,
      message: `queued (${row.trigger})`,
      jobId: row.id,
      mediaFileId: row.mediaFileId,
    });
    ctx.events.emit('job.queued', { job: toJobSummary(row) });
    worker.wake();
    return toJobSummary(row);
  };

  const enqueueOne = async (
    media: MediaFileSummary,
    request: EnqueueRequest,
    plan: NewJob['plan'],
  ): Promise<{ job: JobSummary } | { reason: string }> => {
    if (!request.force && media.status !== 'needs_work') return { reason: `status is ${media.status}` };
    const base = { trigger: 'manual' as const, mediaFileId: media.id, priority: request.priority };
    if (media.kind === 'file') return { job: await enqueue({ ...base, type: 'audio', plan }) };
    const evaluation = await ctx.services.bdmv.evaluate(media.id);
    if (!evaluation.plan) return { reason: evaluation.reason ?? `disc is ${evaluation.status}` };
    return { job: await enqueue({ ...base, type: 'bdmv', bdmvPlan: evaluation.plan }) };
  };

  const enqueueMany = async (request: EnqueueRequest): Promise<EnqueueResponse> => {
    if (!ctx.settings.section('processing').enabled)
      throw new AppError(
        'precondition_failed',
        'processing is disabled (dry-run mode); turn it on before queueing jobs',
      );
    const response: EnqueueResponse = { jobs: [], skipped: [] };
    let handled = 0;
    const pace = async () => {
      handled += 1;
      if (handled % ENQUEUE_SLICE === 0) await yieldToEventLoop();
    };
    const consider = async (media: MediaFileSummary, plan: NewJob['plan']) => {
      try {
        const result = await enqueueOne(media, request, plan);
        if ('job' in result) response.jobs.push(result.job);
        else response.skipped.push({ mediaFileId: media.id, reason: result.reason });
      } catch (error) {
        log.warn('cannot queue media file', { mediaFileId: media.id, error: errorMessage(error) });
        response.skipped.push({ mediaFileId: media.id, reason: errorMessage(error) });
      }
    };

    if (request.mediaFileIds) {
      for (const id of request.mediaFileIds) {
        await pace();
        try {
          const detail = await ctx.services.media.get(id);
          await consider(detail, detail.plan);
        } catch (error) {
          const reason = error instanceof AppError && error.code === 'not_found' ? 'not found' : errorMessage(error);
          response.skipped.push({ mediaFileId: id, reason });
        }
      }
      return response;
    }
    const filter = request.filter ?? {};
    const matches = new Map<number, MediaFileSummary>();
    for (let page = 1; ; page++) {
      const result = await ctx.services.media.list({
        libraryId: filter.libraryId,
        status: filter.status ?? 'needs_work',
        failingCodec: filter.failingCodec,
        kind: filter.kind,
        profileId: filter.profileId,
        search: filter.search,
        codec: filter.codec,
        page,
        pageSize: ENQUEUE_PAGE_SIZE,
        sortDir: 'asc',
      });
      for (const item of result.items) matches.set(item.id, item);
      if (result.items.length === 0 || page * ENQUEUE_PAGE_SIZE >= result.total) break;
    }
    for (const item of matches.values()) {
      await pace();
      await consider(item, null);
    }
    return response;
  };

  const deleteIdleTempPaths = (): number => {
    let deleted = 0;
    for (const row of idleJobsWithTempPath(db)) {
      try {
        if (deleteTempPath(row.tempPath)) deleted += 1;
        updateJobRow(db, row.id, { tempPath: null });
      } catch (error) {
        log.warn('cannot delete temp path', { jobId: row.id, path: row.tempPath, error: errorMessage(error) });
      }
    }
    return deleted;
  };

  const libraryRoots = async (): Promise<string[]> => {
    try {
      return (await ctx.services.libraries.list()).flatMap((library) => library.roots.map((root) => root.path));
    } catch (error) {
      log.warn('cannot list library roots for the temp file sweep', { error: errorMessage(error) });
      return [];
    }
  };

  const sweepOrphans = async (recursive: boolean): Promise<number> =>
    sweepOrphanedTempPaths({
      roots: await libraryRoots(),
      recursive,
      isReferenced: (path) => isTempPathReferenced(db, path),
      onError: (path, error) => log.warn('cannot sweep temp path', { path, error: errorMessage(error) }),
    });

  const recover: JobsService['recover'] = async () => {
    const counts = { requeued: 0, completed: 0, tempFilesDeleted: 0 };
    const { maxAttempts } = ctx.settings.section('processing');
    for (const row of jobsInState(db, 'running')) {
      try {
        const resolution = resolveInterruptedJob(db, row, {
          notes: (line) => log.info(line, { jobId: row.id }),
          now: new Date(),
        });
        if (resolution.kind === 'completed') {
          await lifecycle.completedAfterInterruption(row, resolution.outputPath, 'completed during crash recovery');
          counts.completed += 1;
          continue;
        }
        if (resolution.kind === 'source_missing') {
          if (resolution.tempDeleted) counts.tempFilesDeleted += 1;
          await lifecycle.failed(row, 'source file missing after an interrupted replace');
          continue;
        }
        if (resolution.tempDeleted) counts.tempFilesDeleted += 1;
        const cleared = updateJobRow(db, row.id, { tempPath: null }) ?? row;
        if (cleared.attempts >= maxAttempts) {
          await lifecycle.failed(cleared, `interrupted ${cleared.attempts} times, not retrying automatically`);
          continue;
        }
        await lifecycle.requeued(cleared, 'recovery', 'interrupted by a restart, re-queued');
        counts.requeued += 1;
      } catch (error) {
        log.error('crash recovery failed', { jobId: row.id, path: row.sourcePath, error: errorMessage(error) });
        await lifecycle.failed(row, `crash recovery failed: ${errorMessage(error)}`);
      }
    }
    counts.tempFilesDeleted += deleteIdleTempPaths();
    counts.tempFilesDeleted += await sweepOrphans(false);
    return counts;
  };

  const pruneInBatches = (select: () => { id: number }[], remove: (ids: number[]) => number) => {
    let removed = 0;
    while (true) {
      const ids = select().map((row) => row.id);
      if (ids.length === 0) return removed;
      removed += remove(ids);
      if (ids.length < PRUNE_BATCH) return removed;
    }
  };

  const pruneOldJobs = (): { jobs: number; history: number } => {
    const days = ctx.settings.section('processing').jobRetentionDays;
    if (days === 0) return { jobs: 0, history: 0 };
    const beforeIso = new Date(Date.now() - days * DAY_MS).toISOString();
    const window = { beforeIso, limit: PRUNE_BATCH };
    return {
      jobs: pruneInBatches(
        () => prunableJobIdsQuery(db, window).all(),
        (ids) => deleteJobRows(db, ids),
      ),
      history: pruneInBatches(
        () => expiredHistoryIdsQuery(db, window).all(),
        (ids) => deleteHistoryRows(db, ids),
      ),
    };
  };

  const housekeeping = async (): Promise<string> => {
    const temps = deleteIdleTempPaths() + (await sweepOrphans(true));
    const pruned = pruneOldJobs();
    const logDir = ctx.config.get().jobLogDir;
    const files = existsSync(logDir) ? readdirSync(logDir) : [];
    const byId = new Map<number, string>();
    for (const name of files) {
      const match = JOB_LOG_NAME.exec(name);
      if (match) byId.set(Number(match[1]), name);
    }
    const cutoff = new Date(Date.now() - JOB_LOG_RETENTION_DAYS * DAY_MS).toISOString();
    let logs = 0;
    for (const ids of chunks([...byId.keys()], 500)) {
      const existing = existingJobIds(db, ids);
      const expired = finishedJobIdsBefore(db, ids, cutoff);
      for (const id of ids) {
        if (existing.has(id) && !expired.has(id)) continue;
        const path = join(logDir, byId.get(id) as string);
        try {
          rmSync(path, { force: true });
          logs += 1;
        } catch (error) {
          log.warn('cannot delete job log', { path, error: errorMessage(error) });
        }
      }
    }
    return `deleted ${temps} temp file(s), ${pruned.jobs} old job(s), ${pruned.history} history entr(ies) and ${logs} job log(s)`;
  };

  return {
    enqueue,
    enqueueMany,

    list: async (query) => {
      const window = pageWindow(query);
      const { rows, total } = listJobRows(
        db,
        { states: parseStates(query.state), type: query.type, mediaFileId: query.mediaFileId },
        window,
      );
      return { page: window.page, pageSize: window.pageSize, total, items: rows.map(summary) };
    },

    get: async (id) => {
      const row = mustGet(id);
      const logPath = logPathOf(row);
      return toJobDetail(row, { hasLog: logPath !== null && existsSync(logPath), live: worker.live(id) });
    },

    log: async (id) => {
      const logPath = logPathOf(mustGet(id));
      if (logPath === null || !existsSync(logPath)) return null;
      return Bun.file(logPath).text();
    },

    logTail: async (id, from) => {
      const logPath = logPathOf(mustGet(id));
      if (logPath === null || !existsSync(logPath)) return null;
      return readLogChunk(logPath, { from, maxBytes: LOG_TAIL_BYTES });
    },

    cancel: async (id) => {
      const row = mustGet(id);
      if (row.state === 'queued') return summary(await lifecycle.cancelled(row));
      if (row.state !== 'running') throw new AppError('conflict', `job ${id} is ${row.state}`);
      if (!(await worker.cancel(id))) return summary(await lifecycle.cancelled(row));
      return summary(mustGet(id));
    },

    retry: async (id) => {
      const row = mustGet(id);
      if (row.state !== 'failed' && row.state !== 'cancelled')
        throw new AppError('conflict', `only failed or cancelled jobs can be retried (job ${id} is ${row.state})`);
      const active = row.mediaFileId === null ? undefined : findActiveJobForMedia(db, row.mediaFileId);
      if (active) throw new AppError('conflict', `job ${active.id} is already ${active.state} for this file`);
      const updated =
        updateJobRow(db, id, {
          state: 'queued',
          step: 'waiting',
          trigger: 'retry',
          attempts: 0,
          progress: 0,
          speed: null,
          etaSec: null,
          error: null,
          verification: null,
          outputPath: null,
          startedAt: null,
          finishedAt: null,
        }) ?? row;
      lifecycle.addHistory({
        event: 'retried',
        path: row.sourcePath,
        message: 'retry requested',
        jobId: id,
        mediaFileId: row.mediaFileId,
      });
      ctx.events.emit('job.queued', { job: toJobSummary(updated) });
      worker.wake();
      return summary(updated);
    },

    remove: async (id) => {
      const row = mustGet(id);
      if (row.state === 'queued' || row.state === 'running')
        throw new AppError('conflict', `job ${id} is ${row.state}; cancel it first`);
      const logPath = logPathOf(row);
      if (logPath !== null) rmSync(logPath, { force: true });
      deleteJobRow(db, id);
      ctx.events.emit('job.removed', { jobId: id });
    },

    queue: async () => ({ state: worker.state(), items: queueRows(db, QUEUE_ITEMS_LIMIT).map(summary) }),
    state: () => worker.state(),
    pause: (reason) => worker.pause(reason),
    resume: (reason) => worker.resume(reason),

    history: async (query) => {
      const window = pageWindow(query);
      const { rows, total } = listHistoryRows(
        db,
        { event: query.event, mediaFileId: query.mediaFileId, jobId: query.jobId },
        window,
      );
      return { page: window.page, pageSize: window.pageSize, total, items: rows.map(toHistoryEntry) };
    },

    addHistory: async (entry) => lifecycle.addHistory(entry),
    recover,
    housekeeping,
    start: () => worker.start(),
    stop: () => worker.stop(),
  };
}
