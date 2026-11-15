import { expect, test } from 'bun:test';
import { pageInRange } from './pageInRange.ts';

const result = (page: number, total: number, count: number, pageSize = 50) => ({
  page,
  pageSize,
  total,
  items: Array.from({ length: count }, (_, index) => index),
});

test.each([
  ['the only row of page 2 was deleted', result(2, 50, 0), 1],
  ['a bookmarked page 9 after the library shrank', result(9, 120, 0), 3],
  ['a full page', result(2, 120, 50), null],
  ['an empty list', result(1, 0, 0), null],
  ['an empty list on a stale page', result(4, 0, 0), null],
  ['a page within range that came back empty', result(2, 120, 0), null],
  ['a zero page size', result(3, 10, 0, 0), null],
])('pageInRange - %s gives %p', (_name, input, expected) => {
  expect(pageInRange(input)).toBe(expected);
});
