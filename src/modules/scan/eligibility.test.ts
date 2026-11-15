import { expect, test } from 'bun:test';
import type { MediaFileKind } from '../../shared/domain.ts';
import { DEFAULT_SETTINGS } from '../../shared/settings.ts';
import { type EligibilityRules, exclusionReason, skipPathsFor } from './eligibility.ts';

const RULES: EligibilityRules = {
  extensions: DEFAULT_SETTINGS.media.extensions,
  ignorePatterns: ['**/Sample/**', '**/*.sample.*'],
  discs: true,
  skipPaths: ['/r/Recycle'],
};

test.each<[string, MediaFileKind, Partial<EligibilityRules>, string | null]>([
  ['/r/Movie/Movie.mkv', 'file', {}, null],
  ['/r/Movie/Movie.MKV', 'file', {}, null],
  ['/r/Disc', 'bdmv', {}, null],
  ['/r/Image/Movie.iso', 'iso', {}, null],
  ['/r/.wololo-recycle/old.mkv', 'file', {}, 'hidden or temporary path'],
  ['/r/Movie/.hidden.mkv', 'file', {}, 'hidden or temporary path'],
  ['/r/Movie/Movie.wololo-tmp.mkv', 'file', {}, 'hidden or temporary path'],
  ['/r/Recycle/old.mkv', 'file', {}, 'inside the recycle bin'],
  ['/r/Recycle/old.mkv', 'file', { skipPaths: ['/r/Recycle/'] }, 'inside the recycle bin'],
  ['/r/Disc/BDMV/STREAM/00001.m2ts', 'file', {}, 'inside a disc structure'],
  ['/r/Movie/Sample/sample.mkv', 'file', {}, 'matches an ignore pattern'],
  ['/r/Movie/movie.sample.mkv', 'file', {}, 'matches an ignore pattern'],
  ['/r/Movie/notes.txt', 'file', {}, 'not a media file extension'],
  ['/r/Disc', 'bdmv', { discs: false }, 'disc handling is disabled'],
  ['/r/Image/Movie.iso', 'iso', { discs: false }, 'disc handling is disabled'],
  ['/other/Movie.mkv', 'file', {}, 'outside the library root'],
])('exclusionReason - %s (%s) -> %p', (path, kind, overrides, expected) => {
  expect(exclusionReason('/r', path, kind, { ...RULES, ...overrides })).toBe(expected);
});

test.each<[string | null, string[]]>([
  [null, []],
  ['/data/Recycle/', ['/data/Recycle']],
  ['/data/movies/../Recycle', ['/data/Recycle']],
])('skipPathsFor - %p -> %p', (path, expected) => {
  expect(skipPathsFor({ recycleBin: { ...DEFAULT_SETTINGS.recycleBin, path } })).toEqual(expected);
});
