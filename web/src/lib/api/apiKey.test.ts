import { expect, test } from 'bun:test';
import { reconnectDelay } from './reconnectDelay.ts';
import { resolveApiKey } from './resolveApiKey.ts';

test.each([
  ['injected', 'stored', 'injected'],
  ['', 'stored', 'stored'],
  ['  ', ' stored ', 'stored'],
  [null, null, ''],
  [undefined, '', ''],
  ['', null, ''],
])('resolveApiKey - injected %p and stored %p give %p', (injected, stored, expected) => {
  expect(resolveApiKey(injected, stored)).toBe(expected);
});

test.each([
  [0, 1000],
  [1, 2000],
  [3, 8000],
  [4, 16000],
  [5, 30000],
  [100, 30000],
  [-2, 1000],
  [Number.NaN, 1000],
  [1.7, 2000],
])('reconnectDelay - attempt %p waits %p ms', (attempt, expected) => {
  expect(reconnectDelay(attempt)).toBe(expected);
});
