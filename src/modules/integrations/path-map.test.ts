import { expect, test } from 'bun:test';
import { isSameOrInside, joinRemotePath, mapPath, trimTrailingSeparators } from './path-map.ts';

const MEDIA = [{ from: '/vault/media', to: '/data/media' }];

test.each([
  [
    'mapPath - maps a file below the prefix',
    '/vault/media/movies/A (2020)/a.mkv',
    MEDIA,
    '/data/media/movies/A (2020)/a.mkv',
  ],
  ['mapPath - maps the prefix itself', '/vault/media', MEDIA, '/data/media'],
  ['mapPath - leaves an unmatched path unchanged', '/other/a.mkv', MEDIA, '/other/a.mkv'],
  ['mapPath - no partial segment match', '/vault/media2/a.mkv', MEDIA, '/vault/media2/a.mkv'],
  [
    'mapPath - trailing slash on from and to',
    '/vault/media/a.mkv',
    [{ from: '/vault/media/', to: '/data/media/' }],
    '/data/media/a.mkv',
  ],
  ['mapPath - trailing slash on the input path', '/vault/media/tv/', MEDIA, '/data/media/tv'],
  [
    'mapPath - longest prefix wins regardless of order',
    '/vault/media/movies/a.mkv',
    [
      { from: '/vault', to: '/x' },
      { from: '/vault/media/movies', to: '/movies' },
      { from: '/vault/media', to: '/y' },
    ],
    '/movies/a.mkv',
  ],
  ['mapPath - root prefix maps everything', '/a/b.mkv', [{ from: '/', to: '/data' }], '/data/a/b.mkv'],
  ['mapPath - maps onto the root', '/vault/a.mkv', [{ from: '/vault', to: '/' }], '/a.mkv'],
  ['mapPath - empty mapping list', '/a.mkv', [], '/a.mkv'],
  ['mapPath - ignores an empty from', '/a.mkv', [{ from: '', to: '/x' }], '/a.mkv'],
  [
    'mapPath - Windows remote to POSIX local',
    'D:\\Media\\Movies\\a.mkv',
    [{ from: 'D:\\Media', to: '/data/media' }],
    '/data/media/Movies/a.mkv',
  ],
  [
    'mapPath - Windows prefix matches case-insensitively',
    'd:\\media\\a.mkv',
    [{ from: 'D:\\Media\\', to: '/data' }],
    '/data/a.mkv',
  ],
  [
    'mapPath - POSIX local to Windows remote',
    '/data/media/Movies/a.mkv',
    [{ from: '/data/media', to: 'D:\\Media' }],
    'D:\\Media\\Movies\\a.mkv',
  ],
  ['mapPath - UNC share', '\\\\nas\\media\\a.mkv', [{ from: '\\\\nas\\media', to: '/data' }], '/data/a.mkv'],
  ['mapPath - POSIX prefixes are case-sensitive', '/Vault/media/a.mkv', MEDIA, '/Vault/media/a.mkv'],
] as const)('%s', (_name, path, mappings, expected) => {
  expect(mapPath(path, mappings)).toBe(expected);
});

test.each([
  ['trimTrailingSeparators - strips slashes', '/a/b//', '/a/b'],
  ['trimTrailingSeparators - keeps the root', '/', '/'],
  ['trimTrailingSeparators - collapses a slash-only path to the root', '///', '/'],
  ['trimTrailingSeparators - keeps a drive root', 'C:\\', 'C:\\'],
  ['trimTrailingSeparators - leaves a clean path alone', '/a', '/a'],
])('%s', (_name, input, expected) => {
  expect(trimTrailingSeparators(input)).toBe(expected);
});

test.each([
  ['isSameOrInside - equal paths', '/a/b', '/a/b', true],
  ['isSameOrInside - child path', '/a/b/c.mkv', '/a/b', true],
  ['isSameOrInside - parent with trailing slash', '/a/b/c.mkv', '/a/b/', true],
  ['isSameOrInside - sibling with shared prefix', '/a/bc', '/a/b', false],
  ['isSameOrInside - parent is not inside child', '/a', '/a/b', false],
])('%s', (_name, path, parent, expected) => {
  expect(isSameOrInside(path, parent)).toBe(expected);
});

test.each([
  ['joinRemotePath - POSIX folder', '/movies/A/', 'a.mkv', '/movies/A/a.mkv'],
  ['joinRemotePath - Windows folder keeps backslashes', 'D:\\Movies\\A', 'sub/a.mkv', 'D:\\Movies\\A\\sub\\a.mkv'],
])('%s', (_name, folder, relative, expected) => {
  expect(joinRemotePath(folder, relative)).toBe(expected);
});
