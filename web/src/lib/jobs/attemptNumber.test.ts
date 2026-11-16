import { expect, test } from 'bun:test';
import { attemptNumber } from './attemptNumber.ts';

test.each([
  ['queued', 0, 1],
  ['queued', 1, 2],
  ['running', 1, 1],
  ['running', 2, 2],
  ['completed', 1, 1],
  ['failed', 3, 3],
  ['cancelled', 0, 1],
] as const)('attemptNumber - %s job with %d started attempts is on attempt %d', (state, attempts, expected) => {
  expect(attemptNumber({ state, attempts })).toBe(expected);
});
