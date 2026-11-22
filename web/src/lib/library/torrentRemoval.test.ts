import { expect, test } from 'bun:test';
import type { MediaTorrent, TorrentRemoval } from '#lib/shared.ts';
import { initialRemovalChoice, removalChange, torrentProgress } from './torrentRemoval.ts';

function torrent(overrides: Partial<MediaTorrent> = {}): MediaTorrent {
  return {
    hash: 'abc',
    name: 'Show.S01',
    goalMet: false,
    total: 10,
    done: 3,
    unaccounted: [],
    allConverted: false,
    removal: null,
    ...overrides,
  };
}

function removal(overrides: Partial<TorrentRemoval> = {}): TorrentRemoval {
  return {
    hash: 'abc',
    name: 'Show.S01',
    condition: 'converted',
    state: 'pending',
    reason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

test.each([
  ['no torrent', null, 'keep'],
  ['no request', torrent(), 'keep'],
  ['a pending request', torrent({ removal: removal({ condition: 'converted_and_seeded' }) }), 'converted_and_seeded'],
  ['a finished request', torrent({ removal: removal({ state: 'cancelled' }) }), 'keep'],
] as const)('initialRemovalChoice - %s', (_name, input, expected) => {
  expect(initialRemovalChoice(input)).toBe(expected);
});

test.each([
  ['no torrent', null, 'converted', null],
  ['keep without a request', torrent(), 'keep', null],
  ['keep cancels a pending request', torrent({ removal: removal() }), 'keep', { kind: 'cancel' }],
  ['the same pending condition', torrent({ removal: removal() }), 'converted', null],
  [
    'a different condition',
    torrent({ removal: removal() }),
    'converted_and_seeded',
    { kind: 'request', condition: 'converted_and_seeded' },
  ],
  [
    'a new request after a removed one',
    torrent({ removal: removal({ state: 'removed' }) }),
    'converted',
    { kind: 'request', condition: 'converted' },
  ],
] as const)('removalChange - %s', (_name, input, choice, expected) => {
  expect(removalChange(input, choice)).toEqual(expected);
});

test.each([
  ['a pack', torrent(), '3 of 10 files converted'],
  ['one file', torrent({ total: 1, done: 1 }), '1 of 1 file converted'],
  ['an unimported sample', torrent({ unaccounted: ['sample.mkv'] }), '3 of 10 files converted, 1 not in your library'],
])('torrentProgress - %s', (_name, input, expected) => {
  expect(torrentProgress(input)).toBe(expected);
});
