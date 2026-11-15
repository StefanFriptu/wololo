import { expect, test } from 'bun:test';
import type { TorrentInfo } from '../../shared/domain.ts';
import type { RawTorrent } from './qbittorrent-client.ts';
import { matchTorrent, toTorrentInfo } from './torrent.ts';

function raw(overrides: Partial<RawTorrent> = {}): RawTorrent {
  return {
    hash: 'abc',
    name: 'Heat.1995.BluRay',
    save_path: '/downloads/movies',
    content_path: '/downloads/movies/Heat.1995.BluRay',
    state: 'stalledUP',
    progress: 1,
    ratio: 1.5,
    seeding_time: 3600,
    ratio_limit: -2,
    seeding_time_limit: -2,
    max_ratio: 2,
    max_seeding_time: -1,
    category: 'radarr',
    ...overrides,
  };
}

test.each([
  ['toTorrentInfo - ratio below the effective limit', {}, false],
  ['toTorrentInfo - ratio reaches the effective limit', { ratio: 2 }, true],
  ['toTorrentInfo - seeding time reaches the limit (minutes)', { max_seeding_time: 60 }, true],
  ['toTorrentInfo - seeding time below the limit', { max_seeding_time: 61 }, false],
  ['toTorrentInfo - no limits never meet the goal', { max_ratio: -1, ratio: 50 }, false],
  ['toTorrentInfo - incomplete download never meets the goal', { ratio: 5, progress: 0.5 }, false],
  [
    'toTorrentInfo - per-torrent limit when the effective one is absent',
    { max_ratio: null, ratio_limit: 1, ratio: 1 },
    true,
  ],
  ['toTorrentInfo - per-torrent "use global" without effective value', { max_ratio: null, ratio: 9 }, false],
] as const)('%s', (_name, overrides, goalMet) => {
  expect(toTorrentInfo(raw(overrides)).goalMet).toBe(goalMet);
});

test('toTorrentInfo - maps fields and limits', () => {
  expect(toTorrentInfo(raw({ max_seeding_time: 120 }))).toEqual({
    hash: 'abc',
    name: 'Heat.1995.BluRay',
    savePath: '/downloads/movies',
    contentPath: '/downloads/movies/Heat.1995.BluRay',
    state: 'stalledUP',
    seeding: true,
    ratio: 1.5,
    seedingTimeSec: 3600,
    ratioLimit: 2,
    seedingTimeLimitSec: 7200,
    goalMet: false,
  });
});

test('toTorrentInfo - derives content path from save path and name on old versions', () => {
  expect(toTorrentInfo(raw({ content_path: null })).contentPath).toBe('/downloads/movies/Heat.1995.BluRay');
});

test('toTorrentInfo - stopped torrents are not seeding', () => {
  expect(toTorrentInfo(raw({ state: 'stoppedUP' })).seeding).toBe(false);
});

function torrent(hash: string, contentPath: string): TorrentInfo {
  return { ...toTorrentInfo(raw()), hash, contentPath };
}

const TORRENTS = [
  torrent('folder', '/downloads/Heat'),
  torrent('nested', '/downloads/Heat/Disc'),
  torrent('file', '/downloads/single.mkv'),
];

test.each([
  ['matchTorrent - exact content path', '/downloads/single.mkv', 'file'],
  ['matchTorrent - deepest torrent containing the path', '/downloads/Heat/Disc/BDMV/index.bdmv', 'nested'],
  ['matchTorrent - folder containing a torrent', '/downloads', 'folder'],
  ['matchTorrent - partial name is no match', '/downloads/Heat2/a.mkv', null],
] as const)('%s', (_name, path, expected) => {
  expect(matchTorrent(TORRENTS, path)?.hash ?? null).toBe(expected);
});
