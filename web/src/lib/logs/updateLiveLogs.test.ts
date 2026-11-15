import { expect, test } from 'bun:test';
import type { LogEntry } from '#lib/shared.ts';
import type { LiveLogs } from './LiveLogs.ts';
import { updateLiveLogs } from './updateLiveLogs.ts';

const entry = (id: number, message = `message ${id}`): LogEntry => ({
  id,
  time: '2026-11-15T10:00:00.000Z',
  level: 'info',
  module: 'jobs',
  message,
});
const ids = (list: readonly LogEntry[]) => list.map((item) => item.id);
const empty: LiveLogs = { entries: [], buffered: [], paused: false };

test('updateLiveLogs - after a server restart the new process entries are shown, not the old ones', () => {
  const old = Array.from({ length: 1000 }, (_, index) => entry(5000 + index));
  const before = updateLiveLogs(empty, { type: 'snapshot', entries: old }, 1000);
  const reconnected = updateLiveLogs(before, { type: 'reconnect' }, 1000);
  const live = updateLiveLogs(reconnected, { type: 'entry', entry: entry(2, 'new process') }, 1000);
  const after = updateLiveLogs(live, { type: 'snapshot', entries: [entry(1, 'boot'), entry(2, 'new process')] }, 1000);
  expect(ids(after.entries)).toEqual([1, 2]);
  expect(after.entries.map((item) => item.message)).toEqual(['boot', 'new process']);
});

test('updateLiveLogs - a reconnect also drops entries buffered while paused', () => {
  const paused = updateLiveLogs(empty, { type: 'pause' }, 10);
  const buffered = updateLiveLogs(paused, { type: 'entry', entry: entry(7) }, 10);
  const reconnected = updateLiveLogs(buffered, { type: 'reconnect' }, 10);
  expect(reconnected).toEqual({ entries: [], buffered: [], paused: true });
});

test('updateLiveLogs - the paused buffer keeps only the newest max entries', () => {
  let state = updateLiveLogs(empty, { type: 'pause' }, 3);
  for (let id = 1; id <= 10; id += 1) state = updateLiveLogs(state, { type: 'entry', entry: entry(id) }, 3);
  expect(ids(state.buffered)).toEqual([8, 9, 10]);
  expect(state.entries).toEqual([]);
});

test('updateLiveLogs - resume merges the buffer into the list', () => {
  let state = updateLiveLogs(empty, { type: 'entry', entry: entry(1) }, 10);
  state = updateLiveLogs(state, { type: 'pause' }, 10);
  state = updateLiveLogs(state, { type: 'entry', entry: entry(2) }, 10);
  expect(ids(state.entries)).toEqual([1]);
  state = updateLiveLogs(state, { type: 'resume' }, 10);
  expect(state).toEqual({ entries: [entry(1), entry(2)], buffered: [], paused: false });
});

test('updateLiveLogs - a snapshot from the same process merges without duplicates', () => {
  const state = updateLiveLogs(
    { ...empty, entries: [entry(4), entry(5)] },
    { type: 'snapshot', entries: [entry(3), entry(4)] },
    10,
  );
  expect(ids(state.entries)).toEqual([3, 4, 5]);
});
