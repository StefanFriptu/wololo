import { expect, test } from 'bun:test';
import type { Library, LibraryRoot } from '#lib/shared.ts';
import { libraryFolderChecks } from './libraryFolderChecks.ts';

type LibraryShape = Pick<Library, 'id' | 'name' | 'enabled' | 'profileIds' | 'roots'>;

const ROOT: LibraryRoot = { id: 7, path: '/data/media/movies', freeBytes: 1024, accessible: true, writable: true };

function library(overrides: Partial<LibraryShape> = {}): LibraryShape {
  return { id: 1, name: 'Movies', enabled: true, profileIds: [3], roots: [ROOT], ...overrides };
}

const states = (libraries: LibraryShape[]) =>
  libraryFolderChecks(libraries).map((check) => `${check.key}:${check.state}`);

test.each([
  ['a ready library', library(), ['folder-7:ok']],
  ['no player', library({ profileIds: [] }), ['library-profile-1:bad', 'folder-7:ok']],
  ['no player but disabled', library({ profileIds: [], enabled: false }), ['folder-7:ok']],
  ['an unreachable root', library({ roots: [{ ...ROOT, accessible: false }] }), ['folder-7:bad']],
  ['a read-only root', library({ roots: [{ ...ROOT, writable: false }] }), ['folder-7:warn']],
  ['no roots and no player', library({ profileIds: [], roots: [] }), ['library-profile-1:bad']],
])('libraryFolderChecks - %s', (_name, input, expected) => {
  expect(states([input])).toEqual(expected);
});

test('libraryFolderChecks - a missing player sends the fix to the media step', () => {
  const [check] = libraryFolderChecks([library({ profileIds: [] })]);
  expect(check).toMatchObject({ title: 'Movies has no player', fixStep: 'media' });
});

test('libraryFolderChecks - no libraries, no checks', () => {
  expect(libraryFolderChecks([])).toEqual([]);
});
