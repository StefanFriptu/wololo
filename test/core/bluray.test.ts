import { expect, test } from 'bun:test';
import { blurayInput, playlistArgs, playlistNumber } from '../../src/core/bluray.ts';
import { AppError } from '../../src/core/errors.ts';

test.each([
  ['00800.mpls', 800],
  ['800', 800],
  ['00001.MPLS', 1],
  ['00000.MPLS', 0],
  ['12345.mpls', 12345],
  [' 00800.mpls ', 800],
])('playlistNumber - %s -> %d', (name, expected) => {
  expect(playlistNumber(name)).toBe(expected);
});

test.each(['', 'abc.mpls', '00800.m2ts', '-1', 'index.bdmv', '00800.mpls.bak'])(
  'playlistNumber - rejects %p',
  (name) => {
    expect(() => playlistNumber(name)).toThrow(AppError);
  },
);

test('blurayInput - libbluray protocol URL', () => {
  expect(blurayInput('/data/Disc')).toBe('bluray:/data/Disc');
});

test('playlistArgs - selects the playlist by number', () => {
  expect(playlistArgs('00800.mpls')).toEqual(['-playlist', '800']);
});
