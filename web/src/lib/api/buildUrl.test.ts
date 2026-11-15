import { expect, test } from 'bun:test';
import { buildPath } from './buildPath.ts';
import { buildQuery } from './buildQuery.ts';

test('buildPath - fills and encodes parameters', () => {
  expect(buildPath('/api/v1/system/backups/:name/restore', { name: 'a b.zip' })).toBe(
    '/api/v1/system/backups/a%20b.zip/restore',
  );
  expect(buildPath('/api/v1/jobs/:id', { id: 4 })).toBe('/api/v1/jobs/4');
});

test('buildPath - missing parameter throws', () => {
  expect(() => buildPath('/api/v1/jobs/:id')).toThrow('missing path parameter id');
});

test('buildPath - path without parameters is unchanged', () => {
  expect(buildPath('/api/v1/queue')).toBe('/api/v1/queue');
});

test.each([
  [undefined, ''],
  [{}, ''],
  [{ a: undefined, b: null, c: '' }, ''],
  [{ page: 2, status: 'needs_work' }, '?page=2&status=needs_work'],
  [{ force: false }, '?force=false'],
  [{ term: 'a&b' }, '?term=a%26b'],
])('buildQuery - %p gives %p', (input, expected) => {
  expect(buildQuery(input)).toBe(expected);
});
