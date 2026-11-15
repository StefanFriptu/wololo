import { expect, test } from 'bun:test';
import { formatEstimate } from './formatEstimate.ts';

test.each([
  [null, '-'],
  [Number.NaN, '-'],
  [0, '0m'],
  [-30, '0m'],
  [20, '< 1m'],
  [60, '1m'],
  [12 * 60, '12m'],
  [3600, '1h'],
  [3 * 3600 + 20 * 60, '3h 20m'],
  [86400, '1d'],
  [2 * 86400 + 3 * 3600 + 59, '2d 3h'],
])('formatEstimate - %p renders %p', (input, expected) => {
  expect(formatEstimate(input)).toBe(expected);
});
