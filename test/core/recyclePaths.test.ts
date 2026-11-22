import { expect, test } from 'bun:test';
import { isNormalizedAbsolutePath, isRecyclePath, isRecycleStamp } from '../../src/core/recyclePaths.ts';

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
