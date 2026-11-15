import { expect, test } from 'bun:test';
import { pageRange } from './pageRange.ts';

test.each([
  [1, 0, []],
  [1, 1, [1]],
  [3, 7, [1, 2, 3, 4, 5, 6, 7]],
  [1, 20, [1, 2, 3, 4, 5, null, 20]],
  [4, 20, [1, 2, 3, 4, 5, null, 20]],
  [5, 20, [1, null, 4, 5, 6, null, 20]],
  [10, 20, [1, null, 9, 10, 11, null, 20]],
  [17, 20, [1, null, 16, 17, 18, 19, 20]],
  [20, 20, [1, null, 16, 17, 18, 19, 20]],
  [99, 20, [1, null, 16, 17, 18, 19, 20]],
  [-4, 20, [1, 2, 3, 4, 5, null, 20]],
])('pageRange - page %p of %p shows %p', (current, pages, expected) => {
  expect(pageRange(current, pages)).toEqual(expected);
});
