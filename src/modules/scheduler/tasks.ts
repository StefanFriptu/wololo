import type { AppContext } from '../../app/context.ts';
import { DEFAULT_TASK_INTERVALS, type TaskDefinition } from '../../contracts/probe-scan.ts';
import type { TaskName } from '../../shared/domain.ts';
import type { EventMap } from '../../shared/events.ts';

type ScanFinished = EventMap['scan.finished'];

function scanSummary(finished: ScanFinished): string {
  const { stats } = finished;
  return [
    `${stats.filesSeen} files`,
    `${stats.filesNew} new`,
    `${stats.filesChanged} changed`,
    `${stats.filesRemoved} removed`,
    `${stats.filesProbed} probed`,
    `${stats.probeErrors} errors`,
    `${stats.jobsQueued} queued`,
  ].join(', ');
}

/** Starts a scan of every enabled library (or joins the running one) and waits until it finishes. */
async function runLibraryScan(ctx: AppContext, signal: AbortSignal): Promise<string> {
  const finished = new Map<string, ScanFinished>();
  let notify: (() => void) | null = null;
  const off = ctx.events.on('scan.finished', (payload) => {
    finished.set(payload.scanId, payload);
    notify?.();
  });
  try {
    const started = await ctx.services.scan.start({});
    const onAbort = () => void ctx.services.scan.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      while (!finished.has(started.scanId)) {
        const current = ctx.services.scan.current();
        if (current?.scanId === started.scanId && !current.running) {
          finished.set(started.scanId, { scanId: current.scanId, stats: current.stats, error: current.error });
          break;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const result = finished.get(started.scanId) as ScanFinished;
    if (result.error) throw new Error(`${result.error} (${scanSummary(result)})`);
    return scanSummary(result);
  } finally {
    off();
  }
}

const LABELS: Readonly<Record<TaskName, string>> = {
  library_scan: 'Library scan',
  recycle_bin_purge: 'Recycle bin purge',
  seeding_check: 'Seeding check',
  backup: 'Backup',
  housekeeping: 'Housekeeping',
  log_cleanup: 'Log cleanup',
};

export function taskDefinitions(ctx: AppContext): TaskDefinition[] {
  const { services } = ctx;
  const handlers: Readonly<Record<TaskName, TaskDefinition['run']>> = {
    library_scan: (signal) => runLibraryScan(ctx, signal),
    recycle_bin_purge: async () => {
      const result = await services.recycleBin.purge({});
      return `purged ${result.purged} file(s), freed ${result.freedBytes} bytes`;
    },
    seeding_check: () => services.downloadClient.checkSeedingGoals(),
    backup: async () => `created ${(await services.system.createBackup('scheduled')).name}`,
    housekeeping: () => services.jobs.housekeeping(),
    log_cleanup: () => services.system.cleanupLogs(),
  };
  return (Object.keys(DEFAULT_TASK_INTERVALS) as TaskName[]).map((name) => ({
    name,
    label: LABELS[name],
    defaultIntervalMinutes: DEFAULT_TASK_INTERVALS[name],
    run: handlers[name],
  }));
}
