import type { AppContext } from '../../app/context.ts';
import type { JobLog, JobRunContext } from '../../contracts/jobs.ts';
import { AppError } from '../../core/errors.ts';
import { runProcess } from '../../core/process.ts';
import type { JobRow } from '../../db/schema.ts';
import type { JobStep } from '../../shared/domain.ts';
import { availableBytes, formatBytes, requiredBytes } from './freeSpace.ts';
import { updateJobRow } from './jobQueries.ts';
import { type LiveProgress, toJobDetail } from './mappers.ts';
import { isTempPath } from './paths.ts';
import { createVerifier } from './verify.ts';

const PROGRESS_EVENT_INTERVAL_MS = 500;
const PROGRESS_PERSIST_INTERVAL_MS = 5000;

export interface RunContextDeps {
  ctx: AppContext;
  row: JobRow;
  signal: AbortSignal;
  jobLog: JobLog;
  setLive: (progress: LiveProgress) => void;
  now?: () => number;
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function createRunContext(deps: RunContextDeps): JobRunContext {
  const { ctx, row, signal, jobLog } = deps;
  const now = deps.now ?? (() => Date.now());
  const jobId = row.id;
  let step: JobStep = row.step;
  let lastEvent = 0;
  let lastPersist = now();

  const run: JobRunContext['run'] = async (options) => {
    const { niceLevel, ioniceClass } = ctx.settings.section('processing');
    jobLog.line(`$ ${[options.command, ...options.args].map(quoteArg).join(' ')}`);
    const result = await runProcess({
      ...options,
      signal,
      lowPriority: { niceLevel, ioniceClass },
      onStderrLine: (line) => {
        if (line.trim()) jobLog.line(line);
        options.onStderrLine?.(line);
      },
    });
    jobLog.line(
      `exit ${result.exitCode ?? result.signalCode} after ${(result.durationMs / 1000).toFixed(1)} s${result.aborted ? ' (aborted)' : ''}`,
    );
    return result;
  };

  const verifier = createVerifier({
    run,
    ffmpeg: ctx.config.get().tools.ffmpeg,
    ffprobe: ctx.config.get().tools.ffprobe,
  });

  return {
    job: toJobDetail(row, { hasLog: true }),
    signal,
    log: jobLog,
    setStep: (next, message) => {
      step = next;
      updateJobRow(ctx.db, jobId, { step: next });
      jobLog.section(message ? `${next}: ${message}` : next);
      ctx.events.emit('job.step', { jobId, step: next, message: message ?? null });
    },
    reportProgress: (update) => {
      const progress = Math.min(1, Math.max(0, Number.isFinite(update.progress) ? update.progress : 0));
      const speed = update.speed ?? null;
      const etaSec = update.etaSec ?? null;
      deps.setLive({ progress, speed, etaSec });
      const current = now();
      if (current - lastPersist >= PROGRESS_PERSIST_INTERVAL_MS) {
        lastPersist = current;
        updateJobRow(ctx.db, jobId, { progress, speed, etaSec });
      }
      if (progress < 1 && current - lastEvent < PROGRESS_EVENT_INTERVAL_MS) return;
      lastEvent = current;
      ctx.events.emit('job.progress', { jobId, step, progress, speed, etaSec, outTimeSec: update.outTimeSec ?? null });
    },
    setTempPath: async (path) => {
      if (path !== null && !isTempPath(path))
        throw new AppError('internal', `temp path must contain the temp marker: ${path}`);
      updateJobRow(ctx.db, jobId, { tempPath: path });
      jobLog.line(path === null ? 'temp path cleared' : `temp path: ${path}`);
    },
    run,
    ensureFreeSpace: async (dir, bytes) => {
      const needed = requiredBytes(bytes, ctx.settings.section('processing').freeSpaceMarginPercent);
      const available = availableBytes(dir);
      if (available === null) {
        jobLog.line(`free space of ${dir} unknown (statfs unavailable), continuing`);
        return;
      }
      jobLog.line(`free space in ${dir}: ${formatBytes(available)}, needed ${formatBytes(needed)}`);
      if (available < needed)
        throw new AppError(
          'precondition_failed',
          `not enough free space in ${dir}: ${formatBytes(available)} free, ${formatBytes(needed)} needed`,
        );
    },
    verify: async (request) => {
      const result = await verifier(request);
      updateJobRow(ctx.db, jobId, { verification: result });
      return result;
    },
  };
}
