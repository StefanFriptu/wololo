import type { TaskName } from '../../shared/domain.ts';

const MINUTE_MS = 60_000;

/** Pure: next run of an enabled task; overdue runs (e.g. after downtime) are due now. */
export function nextRunAt(options: {
  lastRunAt: string | null;
  intervalMinutes: number;
  enabled: boolean;
  now: Date;
}): string | null {
  if (!options.enabled) return null;
  const base = options.lastRunAt ? Date.parse(options.lastRunAt) : options.now.getTime();
  const next = Math.max(base + options.intervalMinutes * MINUTE_MS, options.now.getTime());
  return new Date(next).toISOString();
}

/** Pure: enabled tasks whose nextRunAt has passed and that are not running. */
export function dueTasks(
  rows: readonly { name: TaskName; enabled: boolean; nextRunAt: string | null }[],
  now: Date,
  running: ReadonlySet<TaskName>,
): TaskName[] {
  return rows
    .filter((row) => row.enabled && row.nextRunAt !== null && Date.parse(row.nextRunAt) <= now.getTime())
    .filter((row) => !running.has(row.name))
    .map((row) => row.name);
}
