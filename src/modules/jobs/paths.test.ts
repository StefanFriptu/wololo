import { expect, test } from 'bun:test';
import { basename, dirname } from 'node:path';
import { exceedsNameMax, isTempPath, jobLogPathFor, jobTitleFor, outputPathFor, tempPathFor } from './paths.ts';

test.each([
  ['/data/movies/Movie (2020)/Movie (2020).mkv', '/data/movies/Movie (2020)/Movie (2020).wololo-tmp.mkv'],
  ['/data/movies/Movie (2020)/Movie (2020).mp4', '/data/movies/Movie (2020)/Movie (2020).wololo-tmp.mkv'],
  ['/data/tv/Show/S01E01.Title.1080p.MKV', '/data/tv/Show/S01E01.Title.1080p.wololo-tmp.mkv'],
  ['/data/movies/noext', '/data/movies/noext.wololo-tmp.mkv'],
])('tempPathFor - %s writes next to the source', (source, expected) => {
  expect(tempPathFor(source)).toBe(expected);
});

test('tempPathFor - a stem too long for NAME_MAX is shortened to 255 bytes and keeps the marker', () => {
  const stem = 'a'.repeat(246);
  const temp = tempPathFor(`/data/m/${stem}.mkv`);
  const name = basename(temp);
  expect(Buffer.byteLength(name)).toBe(255);
  expect(name.endsWith('.wololo-tmp.mkv')).toBe(true);
  expect(isTempPath(temp)).toBe(true);
  expect(dirname(temp)).toBe('/data/m');
});

test('tempPathFor - shortened multi-byte names stay valid UTF-8 and distinct per source', () => {
  const stem = '進撃の巨人'.repeat(16);
  const first = basename(tempPathFor(`/data/tv/${stem} A.mkv`));
  const second = basename(tempPathFor(`/data/tv/${stem} B.mkv`));
  expect(Buffer.byteLength(first)).toBeLessThanOrEqual(255);
  expect(first).not.toContain('�');
  expect(first).not.toBe(second);
});

test.each([
  ['a.mkv', false],
  [`${'a'.repeat(251)}.mkv`, false],
  [`${'a'.repeat(252)}.mkv`, true],
])('exceedsNameMax - %s is %p', (name, expected) => {
  expect(exceedsNameMax(`/data/m/${name}`)).toBe(expected);
});

test.each([
  ['/data/m/a.mkv', '/data/m/a.mkv'],
  ['/data/m/a.MKV', '/data/m/a.MKV'],
  ['/data/m/a.mp4', '/data/m/a.mkv'],
  ['/data/m/a.b.avi', '/data/m/a.b.mkv'],
  ['/data/m/a.m2ts', '/data/m/a.mkv'],
])('outputPathFor - %s becomes %s', (source, expected) => {
  expect(outputPathFor(source)).toBe(expected);
});

test.each([
  ['/data/m/a.wololo-tmp.mkv', true],
  ['/data/movies/.wololo-tmp-12/', true],
  ['/data/movies/.wololo-tmp-12', true],
  ['/data/m/a.mkv', false],
  ['/data/.wololo-tmp-dir/movie.mkv', false],
  ['/data/m/wololo-tmp.mkv', false],
])('isTempPath - %s is %p', (path, expected) => {
  expect(isTempPath(path)).toBe(expected);
});

test.each([
  ['/data/m/Movie (2020)/Movie (2020).mkv', 'file', 'Movie (2020)'],
  ['/data/downloads/Movie.2020.1080p.BluRay', 'bdmv', 'Movie.2020.1080p.BluRay'],
  ['/data/downloads/Movie.2020.iso', 'iso', 'Movie.2020'],
] as const)('jobTitleFor - %s (%s) is %s', (path, kind, expected) => {
  expect(jobTitleFor(path, kind)).toBe(expected);
});

test('jobLogPathFor - one text file per job id', () => {
  expect(jobLogPathFor('/config/logs/jobs', 42)).toBe('/config/logs/jobs/42.txt');
});
