import { expect, test } from 'bun:test';
import { formatPercent } from './formatPercent.ts';

test.each([
  [null, '-'],
  [Number.NaN, '-'],
  [-0.2, '0%'],
  [0, '0%'],
  [0.425, '42%'],
  [0.999, '99%'],
  [1, '100%'],
  [1.5, '100%'],
])('formatPercent - %p renders %p', (input, expected) => {
  expect(formatPercent(input)).toBe(expected);
});
