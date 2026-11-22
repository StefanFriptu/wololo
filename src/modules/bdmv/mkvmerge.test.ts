import { expect, test } from 'bun:test';
import type { MkvmergeIdentify, MkvmergeOutputTrack, MplsPlaylist, MplsStream } from '../../contracts/bdmv.ts';
import {
  buildMkvmergeArgs,
  buildOutputPaths,
  codecFamily,
  parseMkvmergeIdentify,
  parseMkvmergeProgress,
  sanitizeFileName,
} from './mkvmerge.ts';

const IDENTIFY_JSON = {
  container: { recognized: true, supported: true, type: 'MPEG transport stream' },
  tracks: [
    { id: 0, type: 'video', codec: 'AVC/H.264/MPEG-4p10', properties: { number: 4113, language: 'und' } },
    { id: 1, type: 'audio', codec: 'TrueHD Atmos', properties: { number: 4352, language: 'spa' } },
    { id: 2, type: 'audio', codec: 'AC-3', properties: { number: 4352, language: 'spa' } },
    { id: 3, type: 'audio', codec: 'DTS-HD Master Audio', properties: { number: 4353, language: 'eng' } },
    { id: 4, type: 'subtitles', codec: 'HDMV PGS', properties: { number: 4608, language: 'eng' } },
    { id: 5, type: 'subtitles', codec: 'HDMV PGS', properties: { number: 4609, language_ietf: 'de' } },
    { id: 6, type: 'buttons', codec: 'HDMV IGS', properties: { number: 5120 } },
  ],
};

test('parseMkvmergeIdentify - tracks with PIDs and normalised languages, buttons skipped', () => {
  expect(parseMkvmergeIdentify(IDENTIFY_JSON).tracks).toEqual([
    { id: 0, type: 'video', codec: 'AVC/H.264/MPEG-4p10', pid: 4113, language: null },
    { id: 1, type: 'audio', codec: 'TrueHD Atmos', pid: 4352, language: 'spa' },
    { id: 2, type: 'audio', codec: 'AC-3', pid: 4352, language: 'spa' },
    { id: 3, type: 'audio', codec: 'DTS-HD Master Audio', pid: 4353, language: 'eng' },
    { id: 4, type: 'subtitles', codec: 'HDMV PGS', pid: 4608, language: 'eng' },
    { id: 5, type: 'subtitles', codec: 'HDMV PGS', pid: 4609, language: 'ger' },
  ]);
});

test('parseMkvmergeIdentify - missing properties and tracks', () => {
  expect(parseMkvmergeIdentify({ tracks: [{ id: 0, type: 'video', codec: 'VC-1' }] }).tracks).toEqual([
    { id: 0, type: 'video', codec: 'VC-1', pid: null, language: null },
  ]);
  expect(parseMkvmergeIdentify({ container: {} }).tracks).toEqual([]);
});

test('parseMkvmergeIdentify - rejects unexpected shapes', () => {
  expect(() => parseMkvmergeIdentify({ tracks: [{ id: 'x' }] })).toThrow('unexpected mkvmerge -J output');
  expect(() => parseMkvmergeIdentify(null)).toThrow('unexpected mkvmerge -J output');
});

test.each([
  ['truehd', 'truehd'],
  ['TrueHD Atmos', 'truehd'],
  ['ac3', 'ac3'],
  ['AC-3', 'ac3'],
  ['eac3', 'eac3'],
  ['E-AC-3', 'eac3'],
  ['dts', 'dts'],
  ['DTS-HD Master Audio', 'dts'],
  ['pcm_bluray', 'pcm'],
  ['h264', 'h264'],
  ['AVC/H.264/MPEG-4p10', 'h264'],
  ['HEVC/H.265/MPEG-H', 'hevc'],
  ['vc1', 'vc1'],
  ['VC-1', 'vc1'],
  ['mpeg2video', 'mpeg2'],
  ['MPEG-1/2', 'mpeg2'],
  ['hdmv_pgs_subtitle', 'pgs'],
  ['HDMV PGS', 'pgs'],
  ['opus', 'opus'],
])('codecFamily - %s', (codec, family) => {
  expect(codecFamily(codec)).toBe(family);
});

const stream = (pid: number, kind: MplsStream['kind'], secondaryVideo = false): MplsStream => ({
  kind,
  pid,
  codingType: 0,
  codec: '',
  language: null,
  secondaryVideo,
});

const PLAYLIST: MplsPlaylist = {
  name: '00800.mpls',
  durationSec: 5706,
  playItems: [],
  streams: [stream(4113, 'video'), stream(4117, 'video', true), stream(4352, 'audio'), stream(4608, 'subtitle')],
  marks: [],
  chapterTimesSec: [],
};

const IDENTIFY: MkvmergeIdentify = parseMkvmergeIdentify({
  tracks: [...IDENTIFY_JSON.tracks, { id: 7, type: 'video', codec: 'HEVC/H.265/MPEG-H', properties: { number: 4117 } }],
});

const track = (pid: number, overrides: Partial<MkvmergeOutputTrack> = {}): MkvmergeOutputTrack => ({
  pid,
  replacementPath: null,
  delayMs: 0,
  language: null,
  title: null,
  default: false,
  forced: false,
  ...overrides,
});

const BASE = {
  playlistPath: '/disc/BDMV/PLAYLIST/00800.mpls',
  outputPath: '/tmp/out.mkv',
  playlist: PLAYLIST,
  identify: IDENTIFY,
  title: 'Jamon Jamon (1992)',
  dropSecondaryVideo: true,
};

test('buildMkvmergeArgs - copies selected playlist tracks with languages, flags and track order', () => {
  const args = buildMkvmergeArgs({
    ...BASE,
    tracks: [
      track(4113, { default: true }),
      track(4352, { codec: 'truehd', language: 'spa', default: true, title: 'Castellano' }),
      track(4608, { language: 'eng' }),
    ],
  });
  expect(args).toEqual([
    '--output',
    '/tmp/out.mkv',
    '--title',
    'Jamon Jamon (1992)',
    '--video-tracks',
    '0',
    '--audio-tracks',
    '1',
    '--subtitle-tracks',
    '4',
    '--no-buttons',
    '--language',
    '0:und',
    '--default-track-flag',
    '0:1',
    '--forced-display-flag',
    '0:0',
    '--language',
    '1:spa',
    '--track-name',
    '1:Castellano',
    '--default-track-flag',
    '1:1',
    '--forced-display-flag',
    '1:0',
    '--language',
    '4:eng',
    '--default-track-flag',
    '4:0',
    '--forced-display-flag',
    '4:0',
    '/disc/BDMV/PLAYLIST/00800.mpls',
    '--track-order',
    '0:0,0:1,0:4',
  ]);
});

test('buildMkvmergeArgs - the AC-3 core of a TrueHD PID is chosen by codec', () => {
  const args = buildMkvmergeArgs({ ...BASE, tracks: [track(4113), track(4352, { codec: 'ac3', language: 'spa' })] });
  expect(args.slice(args.indexOf('--audio-tracks'), args.indexOf('--audio-tracks') + 2)).toEqual([
    '--audio-tracks',
    '2',
  ]);
  expect(args.at(-1)).toBe('0:0,0:2');
});

test('buildMkvmergeArgs - without a codec the first track of the PID is used', () => {
  const args = buildMkvmergeArgs({ ...BASE, tracks: [track(4352)] });
  expect(args).toContain('--audio-tracks');
  expect(args[args.indexOf('--audio-tracks') + 1]).toBe('1');
  expect(args).toContain('--no-video');
});

test('buildMkvmergeArgs - replacement side file replaces the playlist track with --sync and its own flags', () => {
  const args = buildMkvmergeArgs({
    ...BASE,
    tracks: [
      track(4113, { default: true }),
      track(4353, { replacementPath: '/tmp/a1.mka', delayMs: -24, language: 'eng', default: true }),
      track(4608, { language: 'eng', forced: true }),
    ],
  });
  expect(args).toContain('--no-audio');
  const side = args.slice(args.indexOf('/disc/BDMV/PLAYLIST/00800.mpls') + 1, args.indexOf('--track-order'));
  expect(side).toEqual([
    '--language',
    '0:eng',
    '--default-track-flag',
    '0:1',
    '--forced-display-flag',
    '0:0',
    '--sync',
    '0:-24',
    '--no-video',
    '--no-subtitles',
    '--no-chapters',
    '--no-global-tags',
    '/tmp/a1.mka',
  ]);
  expect(args.at(-1)).toBe('0:0,1:0,0:4');
  expect(args[args.indexOf('4:1') - 1]).toBe('--forced-display-flag');
});

test('buildMkvmergeArgs - keep-both order: converted side file first, original after', () => {
  const args = buildMkvmergeArgs({
    ...BASE,
    tracks: [
      track(4113),
      track(4353, { replacementPath: '/tmp/a1.mka', language: 'eng', default: true }),
      track(4353, { codec: 'dts', language: 'eng' }),
      track(4352, { replacementPath: '/tmp/a2.mka', language: 'spa' }),
    ],
  });
  expect(args.at(-1)).toBe('0:0,1:0,0:3,2:0');
  expect(args.filter((arg) => arg.endsWith('.mka'))).toEqual(['/tmp/a1.mka', '/tmp/a2.mka']);
});

test('buildMkvmergeArgs - drops the Dolby Vision enhancement layer when asked', () => {
  const tracks = [track(4113), track(4117)];
  const dropped = buildMkvmergeArgs({ ...BASE, tracks });
  expect(dropped[dropped.indexOf('--video-tracks') + 1]).toBe('0');
  expect(dropped.at(-1)).toBe('0:0');
  const kept = buildMkvmergeArgs({ ...BASE, dropSecondaryVideo: false, tracks });
  expect(kept[kept.indexOf('--video-tracks') + 1]).toBe('0,7');
});

test('buildMkvmergeArgs - no subtitles selected', () => {
  expect(buildMkvmergeArgs({ ...BASE, tracks: [track(4113)] })).toContain('--no-subtitles');
});

test('buildMkvmergeArgs - unknown PID fails loudly', () => {
  expect(() => buildMkvmergeArgs({ ...BASE, tracks: [track(0x1fff)] })).toThrow('PID 0x1fff');
});

test.each([
  ['Progress: 42%', 0.42],
  ['#GUI#progress 7%', 0.07],
  ['Progress: 100%', 1],
  ['Multiplexing took 3 seconds.', null],
])('parseMkvmergeProgress - %s', (line, progress) => {
  expect(parseMkvmergeProgress(line)).toBe(progress);
});

test.each([
  ['Mission: Impossible', 'Mission - Impossible'],
  ['AC/DC: Live', 'ACDC - Live'],
  ['What?', 'What'],
  ['Trailing dots...', 'Trailing dots'],
  ['  spaced   out  ', 'spaced out'],
  ['Ratio 2:35', 'Ratio 2-35'],
])('sanitizeFileName - %s', (input, output) => {
  expect(sanitizeFileName(input)).toBe(output);
});

test('buildOutputPaths - main title in "Title (Year)/Title (Year).mkv"', () => {
  expect(
    buildOutputPaths('/data/media/movies', { title: 'Jamón Jamón', year: 1992 }, [
      { playlist: '00800.mpls', role: 'main', edition: null },
    ]),
  ).toEqual(['/data/media/movies/Jamón Jamón (1992)/Jamón Jamón (1992).mkv']);
});

test('buildOutputPaths - editions and extras', () => {
  expect(
    buildOutputPaths('/movies/', { title: 'Blade Runner', year: 1982 }, [
      { playlist: '00800.mpls', role: 'main', edition: 'Final Cut' },
      { playlist: '00801.mpls', role: 'edition', edition: 'Theatrical' },
      { playlist: '00010.mpls', role: 'extra', edition: null },
      { playlist: '00011.mpls', role: 'extra', edition: 'Making Of' },
    ]),
  ).toEqual([
    '/movies/Blade Runner (1982)/Blade Runner (1982) {edition-Final Cut}.mkv',
    '/movies/Blade Runner (1982)/Blade Runner (1982) {edition-Theatrical}.mkv',
    '/movies/Blade Runner (1982)/Featurettes/00010.mkv',
    '/movies/Blade Runner (1982)/Featurettes/Making Of.mkv',
  ]);
});

test('buildOutputPaths - unknown year, unsafe characters and colliding edition names', () => {
  expect(
    buildOutputPaths('/m', { title: 'Alien: Covenant', year: null }, [
      { playlist: '00001.mpls', role: 'main', edition: 'Cut' },
      { playlist: '00002.mpls', role: 'edition', edition: 'Cut' },
    ]),
  ).toEqual([
    '/m/Alien - Covenant/Alien - Covenant {edition-Cut}.mkv',
    '/m/Alien - Covenant/Alien - Covenant {edition-Cut} (00002).mkv',
  ]);
});

test('buildOutputPaths - empty title list', () => {
  expect(buildOutputPaths('/m', { title: 'X', year: 2000 }, [])).toEqual([]);
});
