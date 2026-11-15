import { expect, test } from 'bun:test';
import type { TaskName } from '../../shared/domain.ts';
import { dueTasks, nextRunAt } from './schedule.ts';

const NOW = new Date('2026-11-15T12:00:00.000Z');

test.each([
  ['never ran: one interval from now', null, 60, true, '2026-11-15T13:00:00.000Z'],
  ['ran recently', '2026-11-15T11:30:00.000Z', 60, true, '2026-11-15T12:30:00.000Z'],
  ['overdue after downtime: due now', '2026-11-14T00:00:00.000Z', 360, true, '2026-11-15T12:00:00.000Z'],
  ['disabled', '2026-11-15T11:30:00.000Z', 60, false, null],
] as const)('nextRunAt - %s', (_label, lastRunAt, intervalMinutes, enabled, expected) => {
  expect(nextRunAt({ lastRunAt, intervalMinutes, enabled, now: NOW })).toBe(expected);
});

test('dueTasks - enabled, due and not running', () => {
  const rows: { name: TaskName; enabled: boolean; nextRunAt: string | null }[] = [
    { name: 'library_scan', enabled: true, nextRunAt: '2026-11-15T12:00:00.000Z' },
    { name: 'backup', enabled: true, nextRunAt: '2026-11-15T12:00:00.001Z' },
    { name: 'housekeeping', enabled: false, nextRunAt: '2026-11-15T11:00:00.000Z' },
    { name: 'log_cleanup', enabled: true, nextRunAt: null },
    { name: 'seeding_check', enabled: true, nextRunAt: '2026-11-15T10:00:00.000Z' },
    { name: 'recycle_bin_purge', enabled: true, nextRunAt: '2026-11-15T10:00:00.000Z' },
  ];
  expect(dueTasks(rows, NOW, new Set<TaskName>(['seeding_check']))).toEqual(['library_scan', 'recycle_bin_purge']);
  expect(dueTasks([], NOW, new Set())).toEqual([]);
});
