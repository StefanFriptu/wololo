import { expect, test } from 'bun:test';
import type { LogEntry } from '#lib/shared.ts';
import { filterLogs } from './filterLogs.ts';
import { mergeLogs } from './mergeLogs.ts';

const entry = (id: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  id,
  time: '2026-11-15T10:00:00.000Z',
  level: 'info',
  module: 'jobs',
  message: `message ${id}`,
  ...overrides,
});

test('mergeLogs - appends new entries in id order and drops duplicates', () => {
  const merged = mergeLogs([entry(1), entry(3)], [entry(2), entry(3, { message: 'updated' })], 10);
  expect(merged.map((item) => item.id)).toEqual([1, 2, 3]);
  expect(merged[2]?.message).toBe('updated');
});

test('mergeLogs - keeps only the newest max entries', () => {
  expect(mergeLogs([entry(1), entry(2)], [entry(3)], 2).map((item) => item.id)).toEqual([2, 3]);
});

test('mergeLogs - max of zero keeps nothing', () => {
  expect(mergeLogs([entry(1)], [], 0)).toEqual([]);
});

const sample = [
  entry(1, { level: 'debug', module: 'scan', message: 'walking /data' }),
  entry(2, { level: 'info', module: 'jobs', message: 'Job 4 started' }),
  entry(3, { level: 'warn', module: 'jobs', message: 'Low disk space' }),
  entry(4, { level: 'error', module: 'plex', message: 'Plex unreachable' }),
];

test.each([
  [{ level: 'trace', module: null, search: '' }, [1, 2, 3, 4]],
  [{ level: 'info', module: null, search: '' }, [2, 3, 4]],
  [{ level: 'warn', module: null, search: '' }, [3, 4]],
  [{ level: 'trace', module: 'jobs', search: '' }, [2, 3]],
  [{ level: 'trace', module: null, search: '  PLEX ' }, [4]],
  [{ level: 'error', module: 'jobs', search: '' }, []],
] as const)('filterLogs - %p keeps %p', (filter, expected) => {
  expect(filterLogs(sample, filter).map((item) => item.id)).toEqual([...expected]);
});
