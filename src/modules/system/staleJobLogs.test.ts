import { expect, test } from 'bun:test';
import { jobIdOfLog, selectStaleJobLogs } from './staleJobLogs.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test.each([
  ['42.txt', 42],
  ['7.txt', 7],
  ['wololo.txt', null],
  ['42.log', null],
  ['42.txt.bak', null],
  ['-1.txt', null],
])('jobIdOfLog - %p', (name, expected) => {
  expect(jobIdOfLog(name)).toBe(expected);
});

test('selectStaleJobLogs - removes only old logs of deleted jobs', () => {
  const files = [
    { name: '1.txt', mtimeMs: NOW - 31 * DAY },
    { name: '2.txt', mtimeMs: NOW - 31 * DAY },
    { name: '3.txt', mtimeMs: NOW - 5 * DAY },
    { name: 'notes.txt', mtimeMs: NOW - 90 * DAY },
  ];
  expect(selectStaleJobLogs({ files, existingJobIds: new Set([2]), nowMs: NOW })).toEqual(['1.txt']);
});

test('selectStaleJobLogs - a log exactly at the age limit is kept', () => {
  const files = [{ name: '1.txt', mtimeMs: NOW - 30 * DAY }];
  expect(selectStaleJobLogs({ files, existingJobIds: new Set(), nowMs: NOW })).toEqual([]);
});

test('selectStaleJobLogs - custom age limit', () => {
  const files = [{ name: '1.txt', mtimeMs: NOW - 2 * DAY }];
  expect(selectStaleJobLogs({ files, existingJobIds: new Set(), nowMs: NOW, maxAgeDays: 1 })).toEqual(['1.txt']);
});

test('selectStaleJobLogs - empty input', () => {
  expect(selectStaleJobLogs({ files: [], existingJobIds: new Set(), nowMs: NOW })).toEqual([]);
});
