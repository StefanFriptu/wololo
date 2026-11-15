import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { availableBytes, formatBytes, requiredBytes } from './freeSpace.ts';

test.each([
  [1000, 5, 1050],
  [1000, 0, 1000],
  [1001, 5, 1052],
  [0, 5, 0],
  [-10, 5, 0],
  [8_000_000_000, 5, 8_400_000_000],
])('requiredBytes - %d bytes with %d%% margin need %d', (bytes, margin, expected) => {
  expect(requiredBytes(bytes, margin)).toBe(expected);
});

test.each([
  [0, '0 B'],
  [1023, '1023 B'],
  [1024, '1.0 KiB'],
  [1536 * 1024 * 1024, '1.5 GiB'],
])('formatBytes - %d is %s', (bytes, expected) => {
  expect(formatBytes(bytes)).toBe(expected);
});

test('availableBytes - reports a positive number for an existing directory', () => {
  expect(availableBytes(tmpdir())).toBeGreaterThan(0);
});

test('availableBytes - null for a missing directory', () => {
  expect(availableBytes('/definitely/not/here/wololo')).toBeNull();
});
