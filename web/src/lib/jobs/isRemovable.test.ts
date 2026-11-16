import { expect, test } from 'bun:test';
import { isRemovable } from './isRemovable.ts';

test.each([
  ['queued', false],
  ['running', false],
  ['completed', true],
  ['failed', true],
  ['cancelled', true],
] as const)('isRemovable - %s job removable is %p', (state, expected) => {
  expect(isRemovable(state)).toBe(expected);
});
