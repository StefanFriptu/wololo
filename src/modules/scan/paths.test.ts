import { expect, test } from 'bun:test';
import { isWithin, matchRoot, normalizeRootPath, relativeToRoot, rootsOverlap } from './paths.ts';

test.each([
  ['/data/media/', '/data/media'],
  ['  /data//media/movies/  ', '/data/media/movies'],
  ['/data/media/../tv', '/data/tv'],
  ['/', '/'],
  ['data/media', null],
  ['', null],
])('normalizeRootPath - %p -> %p', (input, expected) => {
  expect(normalizeRootPath(input)).toBe(expected);
});

test.each([
  ['/data/media/movies/a.mkv', '/data/media/movies', true],
  ['/data/media/movies', '/data/media/movies', true],
  ['/data/media/movies2/a.mkv', '/data/media/movies', false],
  ['/data/media', '/data/media/movies', false],
  ['/anything', '/', true],
])('isWithin - %s in %s -> %p', (path, root, expected) => {
  expect(isWithin(path, root)).toBe(expected);
});

test('matchRoot - longest matching root wins', () => {
  const roots = [
    { id: 1, path: '/data/media' },
    { id: 2, path: '/data/media/movies' },
    { id: 3, path: '/data/media/movies-4k' },
  ];
  expect(matchRoot('/data/media/movies/a.mkv', roots)?.id).toBe(2);
  expect(matchRoot('/data/media/movies-4k/a.mkv', roots)?.id).toBe(3);
  expect(matchRoot('/data/media/tv/a.mkv', roots)?.id).toBe(1);
  expect(matchRoot('/other/a.mkv', roots)).toBeNull();
  expect(matchRoot('/data/a.mkv', [])).toBeNull();
});

test.each([
  ['/a', '/a/b', true],
  ['/a/b', '/a', true],
  ['/a', '/a', true],
  ['/a', '/ab', false],
])('rootsOverlap - %s and %s -> %p', (a, b, expected) => {
  expect(rootsOverlap(a, b)).toBe(expected);
});

test.each([
  ['/r/Movie/a.mkv', '/r', 'Movie/a.mkv'],
  ['/r', '/r', '.'],
])('relativeToRoot - %s in %s -> %s', (path, root, expected) => {
  expect(relativeToRoot(path, root)).toBe(expected);
});
