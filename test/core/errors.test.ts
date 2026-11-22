import { expect, test } from 'bun:test';
import { errnoCode } from '../../src/core/errors.ts';

test.each([
  [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'ENOENT'],
  [{ code: 'EEXIST' }, 'EEXIST'],
  [new Error('plain'), undefined],
  [{ code: 42 }, undefined],
  [{ code: undefined }, undefined],
  [null, undefined],
  [undefined, undefined],
  ['ENOENT', undefined],
])('errnoCode - %p -> %p', (error, expected) => {
  expect(errnoCode(error)).toBe(expected);
});
