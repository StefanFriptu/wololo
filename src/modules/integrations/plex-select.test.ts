import { expect, test } from 'bun:test';
import type { PlexSection } from '../../shared/domain.ts';
import { findSectionForPath, pickConnection, toSession } from './plex-select.ts';

const SECTIONS: PlexSection[] = [
  { key: '1', title: 'Movies', type: 'movie', locations: ['/media/movies', '/media2/movies'] },
  { key: '2', title: 'Kids', type: 'movie', locations: ['/media/movies/kids'] },
  { key: '3', title: 'TV', type: 'show', locations: ['/media/tv/'] },
];

test.each([
  ['findSectionForPath - second location of a section', '/media2/movies/A/a.mkv', '1'],
  ['findSectionForPath - deepest location wins', '/media/movies/kids/B', '2'],
  ['findSectionForPath - location with trailing slash', '/media/tv/Show/Season 1', '3'],
  ['findSectionForPath - the location itself', '/media/movies', '1'],
  ['findSectionForPath - no partial segment match', '/media/movies-old/a.mkv', null],
] as const)('%s', (_name, path, key) => {
  expect(findSectionForPath(SECTIONS, path)?.section.key ?? null).toBe(key);
});

test.each([
  [
    'pickConnection - local direct first',
    [
      { uri: 'https://relay', local: false, relay: true },
      { uri: 'https://remote', local: false, relay: false },
      { uri: 'http://lan', local: true, relay: false },
    ],
    'http://lan',
  ],
  [
    'pickConnection - remote direct before relay',
    [
      { uri: 'https://relay', local: false, relay: true },
      { uri: 'https://remote', local: false, relay: false },
    ],
    'https://remote',
  ],
  ['pickConnection - none', [], null],
] as const)('%s', (_name, connections, expected) => {
  expect(pickConnection([...connections])?.uri ?? null).toBe(expected);
});

test('toSession - episode title, user, state and transcode decision', () => {
  expect(
    toSession({
      title: 'Pilot',
      grandparentTitle: 'Show',
      User: { title: 'anna' },
      Player: { state: 'playing' },
      TranscodeSession: { videoDecision: 'copy', audioDecision: 'transcode' },
    }),
  ).toEqual({ title: 'Show - Pilot', user: 'anna', state: 'playing', transcoding: true });
});

test('toSession - direct play without user', () => {
  expect(toSession({ title: 'Heat', TranscodeSession: { videoDecision: 'copy', audioDecision: 'copy' } })).toEqual({
    title: 'Heat',
    user: null,
    state: 'unknown',
    transcoding: false,
  });
});
