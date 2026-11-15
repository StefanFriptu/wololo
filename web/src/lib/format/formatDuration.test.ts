import { expect, test } from 'bun:test';
import { formatDuration } from './formatDuration.ts';

test.each([
  [null, '-'],
  [undefined, '-'],
  [Number.POSITIVE_INFINITY, '-'],
  [-5, '0s'],
  [0, '0s'],
  [12.4, '12s'],
  [59.6, '1m 00s'],
  [245, '4m 05s'],
  [5706, '1h 35m 06s'],
  [90000, '25h 00m 00s'],
])('formatDuration - %p renders %p', (input, expected) => {
  expect(formatDuration(input)).toBe(expected);
});
