import { expect, test } from 'bun:test';
import { AppError } from '../../core/errors.ts';
import { buildProbeArgs, playlistNumber } from './args.ts';

test('buildProbeArgs - file probe with chapters', () => {
  expect(buildProbeArgs('/m/a.mkv')).toEqual([
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of',
    'json',
    '-i',
    '/m/a.mkv',
  ]);
});

test('buildProbeArgs - without chapters', () => {
  expect(buildProbeArgs('/m/a.mkv', { withChapters: false })).not.toContain('-show_chapters');
});

test('buildProbeArgs - playlist probes the disc through bluray:', () => {
  expect(buildProbeArgs('/d/Disc', { playlist: '00800.mpls' }).slice(-4)).toEqual([
    '-playlist',
    '800',
    '-i',
    'bluray:/d/Disc',
  ]);
});

test.each([
  ['00800.mpls', 800],
  ['800', 800],
  ['00001.MPLS', 1],
])('playlistNumber - %s -> %d', (name, expected) => {
  expect(playlistNumber(name)).toBe(expected);
});

test.each(['', 'abc.mpls', '00800.m2ts', '-1'])('playlistNumber - rejects %p', (name) => {
  expect(() => playlistNumber(name)).toThrow(AppError);
});
