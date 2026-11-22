import { expect, test } from 'bun:test';
import { suggestPathMapping } from './suggest-path-mapping.ts';

const existing = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => set.has(path);
};

test('suggestPathMapping - maps the remote root folder onto the local root holding the file', () => {
  expect(
    suggestPathMapping({
      remotePath: '/tv/Severance/Season 2/Severance S02E01.mkv',
      localRoots: ['/data/media/movies', '/data/media/tv'],
      exists: existing('/data/media/tv/Severance/Season 2/Severance S02E01.mkv'),
    }),
  ).toEqual({ remotePath: '/tv', localPath: '/data/media/tv' });
});

test('suggestPathMapping - keeping more segments beats a shallower match', () => {
  expect(
    suggestPathMapping({
      remotePath: '/mnt/media/tv/Show/a.mkv',
      localRoots: ['/data'],
      exists: existing('/data/tv/Show/a.mkv', '/data/Show/a.mkv'),
    }),
  ).toEqual({ remotePath: '/mnt/media', localPath: '/data' });
});

test('suggestPathMapping - Windows remote paths keep their style', () => {
  expect(
    suggestPathMapping({
      remotePath: 'D:\\Media\\Movies\\A (2020)\\a.mkv',
      localRoots: ['/movies/'],
      exists: existing('/movies/A (2020)/a.mkv'),
    }),
  ).toEqual({ remotePath: 'D:\\Media\\Movies', localPath: '/movies' });
});

test('suggestPathMapping - UNC remote paths keep their leading backslashes', () => {
  expect(
    suggestPathMapping({
      remotePath: '\\\\nas\\media\\tv\\Show\\a.mkv',
      localRoots: ['/tv'],
      exists: existing('/tv/Show/a.mkv'),
    }),
  ).toEqual({ remotePath: '\\\\nas\\media\\tv', localPath: '/tv' });
});

test('suggestPathMapping - null when no root holds the file', () => {
  expect(
    suggestPathMapping({ remotePath: '/tv/Show/a.mkv', localRoots: ['/data'], exists: existing('/elsewhere/a.mkv') }),
  ).toBeNull();
});

test('suggestPathMapping - never matches the bare file name alone at a root', () => {
  expect(
    suggestPathMapping({ remotePath: '/a.mkv', localRoots: ['/data'], exists: existing('/data/a.mkv') }),
  ).toBeNull();
});

test('suggestPathMapping - no roots, no suggestion', () => {
  expect(suggestPathMapping({ remotePath: '/tv/Show/a.mkv', localRoots: [], exists: () => true })).toBeNull();
});
