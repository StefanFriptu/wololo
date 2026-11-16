import type { AppContext } from '../../app/context.ts';
import type { JobOutcome } from '../../contracts/jobs.ts';
import { errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { JobRow } from '../../db/schema.ts';
import type {
  ConversionPlan,
  HistoryData,
  HistoryEventType,
  JobTrigger,
  MediaFileStatus,
} from '../../shared/domain.ts';
import { insertHistoryRow, updateJobRow } from './jobQueries.ts';
import { toJobSummary } from './mappers.ts';

export interface HistoryInput {
  event: HistoryEventType;
  path: string;
  message: string;
  jobId?: number | null;
  mediaFileId?: number | null;
  data?: HistoryData | null;
}

export function retaggedStreams(plan: ConversionPlan | null): string[] {
  if (!plan) return [];
  return plan.streams.flatMap((stream, index) =>
    stream.retagged ? [`${stream.kind} ${index} -> ${stream.language ?? 'und'}`] : [],
  );
}

function compact(data: HistoryData): HistoryData {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)),
  ) as HistoryData;
}

export type JobLifecycle = ReturnType<typeof createJobLifecycle>;

export function createJobLifecycle(ctx: AppContext, options: { log: Logger; onChange: () => void }) {
  const { db, events } = ctx;
  const { log } = options;
  const nowIso = () => new Date().toISOString();

  const addHistory = (entry: HistoryInput) => {
    insertHistoryRow(db, {
      event: entry.event,
      path: entry.path,
      message: entry.message,
      jobId: entry.jobId ?? null,
      mediaFileId: entry.mediaFileId ?? null,
      data: entry.data ?? null,
    });
  };

  const setMediaStatus = async (row: JobRow, status: MediaFileStatus, reason: string | null) => {
    if (row.mediaFileId === null) return;
    try {
      await ctx.services.media.setStatus(row.mediaFileId, status, reason);
    } catch (error) {
      log.warn('cannot update media status', { jobId: row.id, status, error: errorMessage(error) });
    }
  };

  const persist = (row: JobRow, patch: Parameters<typeof updateJobRow>[2]): JobRow =>
    updateJobRow(db, row.id, patch) ?? row;

  const cancel = (row: JobRow, message: string): JobRow => {
    const updated = persist(row, {
      state: 'cancelled',
      speed: null,
      etaSec: null,
      tempPath: null,
      finishedAt: nowIso(),
    });
    addHistory({ event: 'cancelled', path: row.sourcePath, message, jobId: row.id, mediaFileId: row.mediaFileId });
    return updated;
  };

  return {
    addHistory,
    setMediaStatus,

    completed(row: JobRow, outcome: JobOutcome): JobRow {
      const skipped = outcome.outputPath === null && outcome.verification === null;
      const updated = persist(row, {
        state: 'completed',
        step: 'done',
        progress: 1,
        speed: null,
        etaSec: null,
        error: null,
        tempPath: null,
        outputPath: outcome.outputPath,
        plan: outcome.plan ?? row.plan,
        afterStreams: outcome.after,
        lostFeatures: outcome.lostFeatures,
        verification: outcome.verification ?? row.verification,
        bytesAfter: outcome.bytesAfter,
        recycleBinEntryId: outcome.recycleBinEntryId ?? row.recycleBinEntryId,
        finishedAt: nowIso(),
      });
      addHistory({
        event: skipped ? 'skipped' : 'completed',
        path: outcome.outputPath ?? row.sourcePath,
        message: outcome.message,
        jobId: row.id,
        mediaFileId: row.mediaFileId,
        data: compact({
          lostFeatures: outcome.lostFeatures,
          bytesBefore: updated.bytesBefore ?? undefined,
          bytesAfter: outcome.bytesAfter ?? undefined,
          outputPath: outcome.outputPath ?? undefined,
          recycleBinEntryId: updated.recycleBinEntryId ?? undefined,
          retagged: retaggedStreams(updated.plan),
        }),
      });
      events.emit('job.finished', { job: toJobSummary(updated), state: 'completed' });
      options.onChange();
      return updated;
    },

    /** The swap is known to have happened (crash recovery or a late error): record the file like a normal completion. */
    async completedAfterInterruption(row: JobRow, outputPath: string, message: string): Promise<JobRow> {
      const warn = (what: string, error: unknown) =>
        log.warn(`${what} failed while completing an interrupted job`, { jobId: row.id, error: errorMessage(error) });
      const { services } = ctx;
      let after: Awaited<ReturnType<typeof services.probe.probe>> | null = null;
      try {
        after = await services.probe.probe(outputPath);
      } catch (error) {
        warn('probe', error);
      }
      if (row.mediaFileId !== null) {
        try {
          const media = await services.media.get(row.mediaFileId);
          await services.media.recordJobResult(row.mediaFileId, {
            status: 'compatible',
            reason: null,
            lastJobId: row.id,
            ...(outputPath === media.path ? {} : { path: outputPath }),
            probe: after,
          });
          await services.notifier.fileChanged({
            kind: 'replaced',
            localPath: outputPath,
            mediaFileId: row.mediaFileId,
            arr: media.arr,
            jobId: row.id,
          });
        } catch (error) {
          warn('media update', error);
        }
      }
      return this.completed(row, {
        outputPath,
        after: after?.streams ?? null,
        lostFeatures: row.plan?.lostFeatures ?? row.lostFeatures,
        verification: row.verification,
        bytesAfter: after?.sizeBytes ?? null,
        recycleBinEntryId: row.recycleBinEntryId,
        message,
      });
    },

    async failed(row: JobRow, message: string): Promise<JobRow> {
      const updated = persist(row, {
        state: 'failed',
        error: message,
        speed: null,
        etaSec: null,
        finishedAt: nowIso(),
      });
      addHistory({
        event: 'failed',
        path: row.sourcePath,
        message,
        jobId: row.id,
        mediaFileId: row.mediaFileId,
        data: { error: message },
      });
      await setMediaStatus(row, 'failed', message);
      events.emit('job.finished', { job: toJobSummary(updated), state: 'failed' });
      options.onChange();
      return updated;
    },

    async cancelled(row: JobRow): Promise<JobRow> {
      const updated = cancel(row, 'cancelled');
      if (row.state === 'running') await setMediaStatus(row, 'needs_work', null);
      events.emit('job.finished', { job: toJobSummary(updated), state: 'cancelled' });
      options.onChange();
      return updated;
    },

    /** Cancels a claimed job whose file must not be touched any more; the media status is left as it is. */
    skipped(row: JobRow, reason: string): JobRow {
      const updated = cancel(row, `cancelled: ${reason}`);
      events.emit('job.finished', { job: toJobSummary(updated), state: 'cancelled' });
      options.onChange();
      return updated;
    },

    async requeued(row: JobRow, trigger: JobTrigger, message: string): Promise<JobRow> {
      const wasRunning = row.state === 'running';
      const updated = persist(row, {
        state: 'queued',
        step: 'waiting',
        trigger,
        progress: 0,
        speed: null,
        etaSec: null,
        error: null,
        tempPath: null,
        startedAt: null,
        finishedAt: null,
      });
      addHistory({ event: 'queued', path: row.sourcePath, message, jobId: row.id, mediaFileId: row.mediaFileId });
      if (wasRunning) await setMediaStatus(row, 'needs_work', null);
      events.emit('job.queued', { job: toJobSummary(updated) });
      options.onChange();
      return updated;
    },
  };
}
