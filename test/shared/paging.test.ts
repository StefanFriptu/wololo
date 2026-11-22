import { expect, test } from 'bun:test';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, resolvePageWindow } from '../../src/shared/paging.ts';

test.each([
  [{}, { page: 1, pageSize: DEFAULT_PAGE_SIZE }],
  [
    { page: 3, pageSize: 20 },
    { page: 3, pageSize: 20 },
  ],
  [
    { page: 0, pageSize: 0 },
    { page: 1, pageSize: 1 },
  ],
  [
    { page: -4, pageSize: -1 },
    { page: 1, pageSize: 1 },
  ],
  [{ pageSize: MAX_PAGE_SIZE }, { page: 1, pageSize: MAX_PAGE_SIZE }],
  [{ pageSize: MAX_PAGE_SIZE + 1 }, { page: 1, pageSize: MAX_PAGE_SIZE }],
])('resolvePageWindow - %j', (query, expected) => {
  expect(resolvePageWindow(query)).toEqual(expected);
});

test('paging - the defaults are 50 and 500', () => {
  expect(DEFAULT_PAGE_SIZE).toBe(50);
  expect(MAX_PAGE_SIZE).toBe(500);
});
