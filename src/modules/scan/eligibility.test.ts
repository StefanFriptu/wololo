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
  ['/r/Movie/Movie.mkv', 'file', { discsOnly: true }, 'library only converts discs'],
  ['/r/Disc', 'bdmv', { discsOnly: true }, null],
  ['/r/Image/Movie.iso', 'iso', { discsOnly: true }, null],
  ['/other/Movie.mkv', 'file', {}, 'outside the library root'],
])('exclusionReason - %s (%s) -> %p', (path, kind, overrides, expected) => {
  expect(exclusionReason('/r', path, kind, { ...RULES, ...overrides })).toBe(expected);
});

const SHARED_CASES: [string, MediaFileKind, string | null][] = [
  ['/r/Movie/Movie.MKV', 'file', null],
  ['/r/Movie/Sample/sample.mkv', 'file', 'matches an ignore pattern'],
  ['/r/Movie/movie.sample.mkv', 'file', 'matches an ignore pattern'],
  ['/r/Movie/notes.txt', 'file', 'not a media file extension'],
  ['/r/Disc', 'bdmv', null],
];

test('exclusionReason - one rules object answers every row like a fresh one', () => {
  const rules: EligibilityRules = { ...RULES, extensions: ['.MKV', '.mp4'] };
  for (const [path, kind, expected] of [...SHARED_CASES, ...SHARED_CASES].reverse()) {
    expect(exclusionReason('/r', path, kind, rules)).toBe(expected);
    expect(exclusionReason('/r', path, kind, { ...rules })).toBe(expected);
  }
});

test('exclusionReason - a new rules object picks up changed patterns and extensions', () => {
  const before: EligibilityRules = { ...RULES, ignorePatterns: [], extensions: ['.mkv'] };
  const after: EligibilityRules = { ...before, ignorePatterns: ['**/Extras/**'], extensions: ['.mp4'] };

  expect(exclusionReason('/r', '/r/Movie/Extras/a.mkv', 'file', before)).toBeNull();
  expect(exclusionReason('/r', '/r/Movie/Extras/a.mkv', 'file', after)).toBe('matches an ignore pattern');
  expect(exclusionReason('/r', '/r/Movie/a.mkv', 'file', after)).toBe('not a media file extension');
});

test.each<[string | null, string[]]>([
  [null, []],
  ['/data/Recycle/', ['/data/Recycle']],
  ['/data/movies/../Recycle', ['/data/Recycle']],
])('skipPathsFor - %p -> %p', (path, expected) => {
  expect(skipPathsFor({ recycleBin: { ...DEFAULT_SETTINGS.recycleBin, path } })).toEqual(expected);
});
