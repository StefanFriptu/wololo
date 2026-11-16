import { expect, test } from 'bun:test';
import {
  binRootFor,
  expiresAtFor,
  isNormalizedAbsolutePath,
  isRecyclePath,
  isRecycleStamp,
  recyclePathFor,
  recycleStamp,
} from './paths.ts';

test('recycleStamp - compact UTC without milliseconds', () => {
  expect(recycleStamp(new Date('2026-11-15T10:30:05.123Z'))).toBe('20261115T103005Z');
});

test.each([
  ['20261115T103005Z', true],
  ['20261115T103005Z-2', true],
  ['20261115T103005', false],
  ['Movie (2020)', false],
  ['.wololo-recycle', false],
])('isRecycleStamp - %s is %p', (name, expected) => {
  expect(isRecycleStamp(name)).toBe(expected);
});

test.each([
  ['/data/movies/.wololo-recycle/20261115T103005Z/Movie (2020)/Movie (2020).mkv', true],
  ['/recycle/20261115T103005Z-2/a.mkv', true],
  ['/config/config.json', false],
  ['/proc/self/environ', false],
  ['/recycle/20261115T103005Z', false],
  ['/recycle/20261115T103005Z/../../config/config.json', false],
  ['relative/20261115T103005Z/a.mkv', false],
  ['/recycle/20261115T103005Z/a.mkv/', false],
])('isRecyclePath - %s is %p', (path, expected) => {
  expect(isRecyclePath(path)).toBe(expected);
});

test.each([
  ['/data/movies/a.mkv', true],
  ['/data/movies/../a.mkv', false],
  ['data/a.mkv', false],
  ['/data//a.mkv', false],
])('isNormalizedAbsolutePath - %s is %p', (path, expected) => {
  expect(isNormalizedAbsolutePath(path)).toBe(expected);
});

test.each([
  [{ configuredPath: '/data/recycle', rootPath: '/data/movies', path: '/data/movies/a/a.mkv' }, '/data/recycle'],
  [{ configuredPath: null, rootPath: '/data/movies', path: '/data/movies/a/a.mkv' }, '/data/movies/.wololo-recycle'],
  [{ configuredPath: null, rootPath: null, path: '/elsewhere/a/a.mkv' }, '/elsewhere/a/.wololo-recycle'],
])('binRootFor - %o is %s', (options, expected) => {
  expect(binRootFor(options)).toBe(expected);
});

test.each([
  [
    { rootPath: '/data/movies', originalPath: '/data/movies/Movie (2020)/Movie (2020).mkv' },
    '/bin/20261115T103005Z/Movie (2020)/Movie (2020).mkv',
  ],
  [{ rootPath: '/data/movies/', originalPath: '/data/movies/a.mkv' }, '/bin/20261115T103005Z/a.mkv'],
  [{ rootPath: '/data/movies', originalPath: '/data/movies-4k/a/a.mkv' }, '/bin/20261115T103005Z/a.mkv'],
  [{ rootPath: null, originalPath: '/x/y/z.mkv' }, '/bin/20261115T103005Z/z.mkv'],
  [{ rootPath: null, originalPath: '/x/y/z.mkv', attempt: 2 }, '/bin/20261115T103005Z-2/z.mkv'],
])('recyclePathFor - %o is %s', (options, expected) => {
  expect(recyclePathFor({ binRoot: '/bin', stamp: '20261115T103005Z', ...options })).toBe(expected);
});

test.each([
  [7, '2026-11-22T10:00:00.000Z'],
  [0, '2026-11-15T10:00:00.000Z'],
  [365, '2027-11-15T10:00:00.000Z'],
])('expiresAtFor - %d days', (days, expected) => {
  expect(expiresAtFor(new Date('2026-11-15T10:00:00.000Z'), days)).toBe(expected);
});
