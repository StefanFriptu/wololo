import { expect, test } from 'bun:test';
import { positiveIntParam, queryString } from './queryParams.ts';

test.each([
  [null, undefined],
  ['', undefined],
  ['0', undefined],
  ['-1', undefined],
  ['1.5', undefined],
  ['abc', undefined],
  ['1', 1],
  ['42', 42],
])('positiveIntParam - %p -> %p', (value, expected) => {
  expect(positiveIntParam(value)).toBe(expected);
});

test('queryString - skips undefined and empty values', () => {
  expect(queryString({ a: 1, b: undefined, c: '', d: 'x y' })).toBe('?a=1&d=x+y');
});

test('queryString - is empty when nothing is set', () => {
  expect(queryString({ a: undefined })).toBe('');
  expect(queryString({})).toBe('');
});
