import { expect, test } from 'bun:test';
import { isWithin } from '../../src/core/isWithin.ts';

test.each([
  ['/data/media/movies/a.mkv', '/data/media/movies', true],
  ['/data/media/movies', '/data/media/movies', true],
  ['/data/media/movies/', '/data/media/movies', true],
  ['/data/media/movies2/a.mkv', '/data/media/movies', false],
  ['/data/media', '/data/media/movies', false],
  ['/anything', '/', true],
  ['/', '/', true],
  ['', '/data', false],
  ['/data/media/Recycle', '/data/media/Recycle/', true],
  ['/data/media/Recycle/', '/data/media/Recycle/', true],
  ['/data/media/Recycle/old.mkv', '/data/media/Recycle/', true],
  ['/data/media/Recycled', '/data/media/Recycle/', false],
  ['/a/bc', '/a/b', false],
  ['/a/b/c/d', '/a/b', true],
])('isWithin - %s in %s -> %p', (path, folder, expected) => {
  expect(isWithin(path, folder)).toBe(expected);
});
