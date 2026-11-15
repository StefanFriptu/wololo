import { statSync } from 'node:fs';
import type { AppContext } from '../../app/context.ts';
import type { JobExecutor } from '../../contracts/jobs.ts';
import { errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { JobRow } from '../../db/schema.ts';
import type { JobType, QueuePauseReason, QueueState } from '../../shared/domain.ts';
import { createJobLog } from './jobLog.ts';
import { claimNextQueued, countJobsInState, getJobRow, updateJobRow } from './jobQueries.ts';
import type { JobLifecycle } from './lifecycle.ts';
import { type LiveProgress, toJobSummary } from './mappers.ts';
import { jobLogPathFor } from './paths.ts';
import { resolveInterruptedJob } from './recover.ts';
import { createRunContext } from './runContext.ts';
import { isWithinProcessingWindow } from './window.ts';

const TICK_INTERVAL_MS = 15_000;
const PLEX_POLL_INTERVAL_MS = 30_000;
const PAUSE_REASON_ORDER: readonly QueuePauseReason[] = ['user', 'window', 'plex_streaming', 'shutdown'];

type AbortReason = 'cancel' | 'shutdown';

export interface WorkerDeps {
  ctx: AppContext;
  log: Logger;
  lifecycle: JobLifecycle;
  executorFor: (type: JobType) => JobExecutor;
  now?: () => Date;
}

export type Worker = ReturnType<typeof createWorker>;

function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/**
 * The in-process queue runner. A tick re-evaluates the gates (processing enabled, user pause, processing window, Plex
 * playback) and starts queued jobs up to the configured concurrency. Gates only hold back new jobs; a running job
 * finishes at low priority. Ticks run on a timer, on settings changes and whenever a job is queued or finishes.
 */
export function createWorker(deps: WorkerDeps) {
  const { ctx, log, lifecycle } = deps;
  const now = deps.now ?? (() => new Date());
  const manualReasons = new Set<QueuePauseReason>();
  const active = new Map<number, { controller: AbortController; done: Promise<void> }>();
  const live = new Map<number, LiveProgress>();
  let windowClosed = false;
  let plexStreaming = false;
  let plexCheckedAt = Number.NEGATIVE_INFINITY;
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastState = '';
  let ticking = false;
  let tickAgain = false;

  const pauseReasons = (): QueuePauseReason[] =>
    PAUSE_REASON_ORDER.filter(
      (reason) =>
        manualReasons.has(reason) ||
        (reason === 'window' && windowClosed) ||
        (reason === 'plex_streaming' && plexStreaming),
    );

  const state = (): QueueState => {
    const reasons = pauseReasons();
    return {
      paused: reasons.length > 0,
      pauseReasons: reasons,
      running: active.size,
      queued: countJobsInState(ctx.db, 'queued'),
      concurrency: ctx.settings.section('processing').concurrency,
    };
  };

  const emitState = () => {
    const current = state();
    const json = JSON.stringify(current);
    if (json === lastState) return;
    lastState = json;
    ctx.events.emit('queue.state', current);
  };

  const plexWantsPause = async (): Promise<boolean> => {
    if (ctx.settings.section('processing').pauseWhilePlexStreaming) return true;
    try {
      return (await ctx.services.plex.connection()).pauseWhileStreaming;
    } catch (error) {
      log.debug('plex connection unavailable for the streaming gate', { error: errorMessage(error) });
      return false;
    }
  };

  const refreshGates = async () => {
    windowClosed = !isWithinProcessingWindow(ctx.settings.section('processing').window, now());
    const due = Date.now() - plexCheckedAt >= PLEX_POLL_INTERVAL_MS;
    if (!due || countJobsInState(ctx.db, 'queued') === 0) return;
    plexCheckedAt = Date.now();
    if (!(await plexWantsPause())) {
      plexStreaming = false;
      return;
    }
    try {
      plexStreaming = (await ctx.services.plex.sessions()).active > 0;
    } catch (error) {
      log.warn('cannot read Plex sessions, not pausing', { error: errorMessage(error) });
      plexStreaming = false;
    }
  };

  const handleFailure = async (
    jobId: number,
    error: unknown,
    signal: AbortSignal,
    jobLog: ReturnType<typeof createJobLog>,
  ) => {
    const row = getJobRow(ctx.db, jobId);
    if (!row) return;
    const message = errorMessage(error);
    let resolution: ReturnType<typeof resolveInterruptedJob> | null = null;
    try {
      resolution = resolveInterruptedJob(ctx.db, row, (line) => jobLog.line(line));
    } catch (cleanupError) {
      jobLog.line(`cleanup failed: ${errorMessage(cleanupError)}`);
      log.error('cleanup after a failed job failed', { jobId, path: row.tempPath, error: errorMessage(cleanupError) });
    }
    if (resolution?.kind === 'completed') {
      jobLog.section(`completed despite a late error: ${message}`);
      await lifecycle.completedAfterInterruption(row, resolution.outputPath, `completed (late error: ${message})`);
      return;
    }
    const settled = resolution ? (updateJobRow(ctx.db, jobId, { tempPath: null }) ?? row) : row;
    const reason = signal.aborted ? (signal.reason as AbortReason) : null;
    if (reason === 'shutdown') {
      jobLog.section('interrupted by shutdown, re-queued');
      const restored = updateJobRow(ctx.db, jobId, { attempts: Math.max(0, settled.attempts - 1) }) ?? settled;
      await lifecycle.requeued(restored, restored.trigger, 'interrupted by shutdown');
      return;
    }
    if (reason === 'cancel') {
      jobLog.section('cancelled');
      await lifecycle.cancelled(settled);
      return;
    }
    const failure = resolution?.kind === 'source_missing' ? `source missing after an error: ${message}` : message;
    jobLog.section(`failed: ${failure}`);
    log.warn('job failed', { jobId, path: row.sourcePath, error: failure });
    await lifecycle.failed(settled, failure);
  };

  const runJob = async (claimed: JobRow, controller: AbortController) => {
    const jobId = claimed.id;
    const logPath = jobLogPathFor(ctx.config.get().jobLogDir, jobId);
    const row =
      updateJobRow(ctx.db, jobId, {
        logPath,
        bytesBefore: (claimed.type === 'audio' ? fileSize(claimed.sourcePath) : null) ?? claimed.bytesBefore,
      }) ?? claimed;
    const jobLog = createJobLog(logPath, { log });
    jobLog.section(`attempt ${row.attempts} (${row.trigger}): ${row.type} ${row.sourcePath}`);
    ctx.events.emit('job.started', { job: toJobSummary(row) });
    lifecycle.addHistory({
      event: 'started',
      path: row.sourcePath,
      message: `attempt ${row.attempts}`,
      jobId,
      mediaFileId: row.mediaFileId,
    });
    await lifecycle.setMediaStatus(row, 'processing', null);
    emitState();
    try {
      const runCtx = createRunContext({
        ctx,
        row,
        signal: controller.signal,
        jobLog,
        setLive: (progress) => live.set(jobId, progress),
      });
      const outcome = await deps.executorFor(row.type)(runCtx);
      jobLog.section(`completed: ${outcome.message}`);
      lifecycle.completed(getJobRow(ctx.db, jobId) ?? row, outcome);
    } catch (error) {
      await handleFailure(jobId, error, controller.signal, jobLog);
    }
  };

  const launch = (row: JobRow) => {
    const controller = new AbortController();
    const done = runJob(row, controller)
      .catch((error) => log.error('job runner crashed', { jobId: row.id, error: errorMessage(error) }))
      .finally(() => {
        active.delete(row.id);
        live.delete(row.id);
        void tick();
      });
    active.set(row.id, { controller, done });
  };

  const startAvailable = () => {
    while (started && pauseReasons().length === 0) {
      const processing = ctx.settings.section('processing');
      if (!processing.enabled || active.size >= processing.concurrency) return;
      const row = claimNextQueued(ctx.db);
      if (!row) return;
      launch(row);
    }
  };

  async function tick(): Promise<void> {
    if (!started) {
      emitState();
      return;
    }
    if (ticking) {
      tickAgain = true;
      return;
    }
    ticking = true;
    try {
      do {
        tickAgain = false;
        await refreshGates();
        startAvailable();
        emitState();
      } while (tickAgain && started);
    } catch (error) {
      log.error('worker tick failed', { error: errorMessage(error) });
    } finally {
      ticking = false;
    }
  }

  return {
    state,
    live: (jobId: number) => live.get(jobId),
    isRunning: (jobId: number) => active.has(jobId),
    wake: () => void tick(),

    pause(reason: QueuePauseReason): QueueState {
      manualReasons.add(reason);
      emitState();
      return state();
    },

    resume(reason: QueuePauseReason): QueueState {
      manualReasons.delete(reason);
      if (reason === 'plex_streaming') {
        plexStreaming = false;
        plexCheckedAt = Number.NEGATIVE_INFINITY;
      }
      void tick();
      return state();
    },

    /** Aborts a running job and waits until it settled; false when the job is not running here. */
    async cancel(jobId: number): Promise<boolean> {
      const entry = active.get(jobId);
      if (!entry) return false;
      entry.controller.abort('cancel' satisfies AbortReason);
      await entry.done;
      return true;
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      manualReasons.delete('shutdown');
      timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
      timer.unref?.();
      unsubscribe = ctx.events.on('settings.changed', () => {
        plexCheckedAt = Number.NEGATIVE_INFINITY;
        void tick();
      });
      await tick();
    },

    async stop(): Promise<void> {
      started = false;
      manualReasons.add('shutdown');
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      for (const entry of active.values()) entry.controller.abort('shutdown' satisfies AbortReason);
      await Promise.allSettled([...active.values()].map((entry) => entry.done));
      emitState();
    },
  };
}
