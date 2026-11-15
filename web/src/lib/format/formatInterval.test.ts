import { expect, test } from 'bun:test';
import { formatInterval } from './formatInterval.ts';

test.each([
  [0, '-'],
  [-10, '-'],
  [Number.NaN, '-'],
  [1, '1 minute'],
  [45, '45 minutes'],
  [60, '1 hour'],
  [90, '90 minutes'],
  [360, '6 hours'],
  [1440, '1 day'],
  [10080, '7 days'],
])('formatInterval - %p minutes render %p', (input, expected) => {
  expect(formatInterval(input)).toBe(expected);
});
