import { expect, test } from 'bun:test';
import { writeClpi, writeMpls } from '../../../test/fixtures/bdmv/writers.ts';
import { MPLS_TICKS_PER_SECOND } from '../../contracts/bdmv.ts';
import { chapterTimes, codecForCodingType, parseClpi, parseMpls, withClipLanguages } from './mpls.ts';

const T = MPLS_TICKS_PER_SECOND;
const IN = 27_000_000;

const FEATURE_STN = {
  video: [{ pid: 0x1011, codingType: 0x1b }],
  audio: [
    { pid: 0x1100, codingType: 0x86, language: 'spa' },
    { pid: 0x1101, codingType: 0x81, language: 'eng' },
  ],
  pg: [{ pid: 0x1200, codingType: 0x90, language: 'eng' }],
  ig: [{ pid: 0x1400, codingType: 0x91, language: 'eng' }],
};

test('parseMpls - single clip playlist with streams, languages and chapters', () => {
  const bytes = writeMpls({
    playItems: [{ clipId: '00001', inTime: IN, outTime: IN + 5706 * T, stn: FEATURE_STN }],
    marks: [
      { playItem: 0, time: IN },
      { playItem: 0, time: IN + 600 * T },
      { playItem: 0, time: IN + 1200 * T, type: 2 },
    ],
  });
  const playlist = parseMpls('00800.mpls', bytes);
  expect(playlist.name).toBe('00800.mpls');
  expect(playlist.durationSec).toBe(5706);
  expect(playlist.playItems).toEqual([
    {
      clipId: '00001',
      inTime: IN,
      outTime: IN + 5706 * T,
      durationSec: 5706,
      angleClipIds: [],
      connectionCondition: 1,
    },
  ]);
  expect(playlist.streams).toEqual([
    { kind: 'video', pid: 0x1011, codingType: 0x1b, codec: 'h264', language: null, secondaryVideo: false },
    { kind: 'audio', pid: 0x1100, codingType: 0x86, codec: 'dts', language: 'spa', secondaryVideo: false },
    { kind: 'audio', pid: 0x1101, codingType: 0x81, codec: 'ac3', language: 'eng', secondaryVideo: false },
    {
      kind: 'subtitle',
      pid: 0x1200,
      codingType: 0x90,
      codec: 'hdmv_pgs_subtitle',
      language: 'eng',
      secondaryVideo: false,
    },
    { kind: 'interactive', pid: 0x1400, codingType: 0x91, codec: 'hdmv_igs', language: 'eng', secondaryVideo: false },
  ]);
  expect(playlist.marks).toEqual([
    { playItemIndex: 0, timeSec: 0, entryMark: true },
    { playItemIndex: 0, timeSec: 600, entryMark: true },
    { playItemIndex: 0, timeSec: 1200, entryMark: false },
  ]);
  expect(playlist.chapterTimesSec).toEqual([0, 600]);
});

test('parseMpls - multi-clip playlist accumulates durations and mark times across play items', () => {
  const bytes = writeMpls({
    playItems: [
      { clipId: '00010', inTime: IN, outTime: IN + 100 * T, stn: FEATURE_STN },
      { clipId: '00011', inTime: 900 * T, outTime: 1000 * T, connectionCondition: 5 },
      { clipId: '00012', inTime: 0, outTime: 50 * T, connectionCondition: 6 },
    ],
    marks: [
      { playItem: 0, time: IN },
      { playItem: 1, time: 950 * T },
      { playItem: 2, time: 10 * T },
    ],
  });
  const playlist = parseMpls('00001.mpls', bytes);
  expect(playlist.durationSec).toBe(250);
  expect(playlist.playItems.map((item) => [item.clipId, item.connectionCondition])).toEqual([
    ['00010', 1],
    ['00011', 5],
    ['00012', 6],
  ]);
  expect(playlist.marks.map((mark) => mark.timeSec)).toEqual([0, 150, 210]);
  expect(playlist.chapterTimesSec).toEqual([0, 150, 210]);
});

test('parseMpls - multi-angle play item lists its angle clips', () => {
  const bytes = writeMpls({
    playItems: [{ clipId: '00020', inTime: 0, outTime: 60 * T, angleClipIds: ['00021', '00022'], stn: FEATURE_STN }],
  });
  const playlist = parseMpls('00002.mpls', bytes);
  expect(playlist.playItems[0]?.angleClipIds).toEqual(['00021', '00022']);
  expect(playlist.streams.map((stream) => stream.pid)).toEqual([0x1011, 0x1100, 0x1101, 0x1200, 0x1400]);
});

test('parseMpls - stream table is taken from the first play item only', () => {
  const bytes = writeMpls({
    playItems: [
      { clipId: '00001', inTime: 0, outTime: T, stn: { audio: [{ pid: 0x1100, codingType: 0x83, language: 'ger' }] } },
      { clipId: '00002', inTime: 0, outTime: T, stn: { audio: [{ pid: 0x1105, codingType: 0x81, language: 'fre' }] } },
    ],
  });
  expect(parseMpls('00003.mpls', bytes).streams).toEqual([
    { kind: 'audio', pid: 0x1100, codingType: 0x83, codec: 'truehd', language: 'ger', secondaryVideo: false },
  ]);
});

test('parseMpls - secondary audio, secondary video, PiP PG and Dolby Vision streams', () => {
  const bytes = writeMpls({
    playItems: [
      {
        clipId: '00001',
        inTime: 0,
        outTime: 10 * T,
        stn: {
          video: [{ pid: 0x1011, codingType: 0x24 }],
          audio: [{ pid: 0x1100, codingType: 0x83, language: 'deu' }],
          pg: [{ pid: 0x1200, codingType: 0x90, language: 'en' }],
          pipPg: [{ pid: 0x1201, codingType: 0x90, language: 'fra' }],
          secondaryAudio: [{ pid: 0x1a00, codingType: 0xa1, language: 'eng', entryType: 2 }],
          secondaryVideo: [{ pid: 0x1b00, codingType: 0x1b, entryType: 3 }],
          dolbyVision: [{ pid: 0x1015, codingType: 0x24 }],
        },
      },
    ],
  });
  const streams = parseMpls('00004.mpls', bytes).streams;
  expect(streams.map((s) => [s.kind, s.pid, s.codec, s.language, s.secondaryVideo])).toEqual([
    ['video', 0x1011, 'hevc', null, false],
    ['audio', 0x1100, 'truehd', 'ger', false],
    ['subtitle', 0x1200, 'hdmv_pgs_subtitle', 'eng', false],
    ['subtitle', 0x1201, 'hdmv_pgs_subtitle', 'fre', false],
    ['audio', 0x1a00, 'eac3', 'eng', false],
    ['video', 0x1b00, 'h264', null, true],
    ['video', 0x1015, 'hevc', null, true],
  ]);
});

test('parseMpls - MVC dependent view is secondary video', () => {
  const bytes = writeMpls({
    playItems: [
      {
        clipId: '00001',
        inTime: 0,
        outTime: T,
        stn: {
          video: [
            { pid: 0x1011, codingType: 0x1b },
            { pid: 0x1012, codingType: 0x20 },
          ],
        },
      },
    ],
  });
  expect(parseMpls('00005.mpls', bytes).streams.map((s) => s.secondaryVideo)).toEqual([false, true]);
});

test('parseMpls - text subtitles and undetermined languages', () => {
  const bytes = writeMpls({
    playItems: [
      {
        clipId: '00001',
        inTime: 0,
        outTime: T,
        stn: {
          audio: [{ pid: 0x1100, codingType: 0x80, language: 'und' }],
          pg: [{ pid: 0x1800, codingType: 0x92, language: 'jpn' }],
        },
      },
    ],
  });
  const streams = parseMpls('00006.mpls', bytes).streams;
  expect(streams.map((s) => [s.kind, s.codec, s.language])).toEqual([
    ['audio', 'pcm_bluray', null],
    ['subtitle', 'hdmv_text_subtitle', 'jpn'],
  ]);
});

test('parseMpls - marks pointing at a missing play item are skipped', () => {
  const bytes = writeMpls({
    playItems: [{ clipId: '00001', inTime: 0, outTime: 100 * T }],
    marks: [
      { playItem: 0, time: 0 },
      { playItem: 7, time: 0 },
    ],
  });
  expect(parseMpls('00007.mpls', bytes).marks).toHaveLength(1);
});

test('parseMpls - rejects files without the MPLS magic', () => {
  const bytes = writeClpi({});
  expect(() => parseMpls('00008.mpls', bytes)).toThrow('not an MPLS file');
});

test('parseMpls - truncated input throws instead of reading garbage', () => {
  const bytes = writeMpls({ playItems: [{ clipId: '00001', inTime: 0, outTime: T, stn: FEATURE_STN }] });
  expect(() => parseMpls('00009.mpls', bytes.subarray(0, 80))).toThrow('truncated');
});

test('parseMpls - empty playlist has zero duration and no streams', () => {
  const playlist = parseMpls('00010.mpls', writeMpls({ playItems: [] }));
  expect(playlist.durationSec).toBe(0);
  expect(playlist.streams).toEqual([]);
  expect(playlist.chapterTimesSec).toEqual([]);
});

test.each([
  ['entry marks sorted', [30, 0, 10], 100, [0, 10, 30]],
  ['duplicates removed', [0, 0, 10, 10], 100, [0, 10]],
  ['last mark within 5 s of the end is dropped (as mkvmerge does)', [0, 50, 96], 100, [0, 50]],
  ['mark at the end is dropped', [0, 50, 100], 100, [0, 50]],
  ['mark 6 s before the end is kept', [0, 94], 100, [0, 94]],
  ['no marks', [], 100, []],
] as const)('chapterTimes - %s', (_name, times, duration, expected) => {
  const marks = times.map((timeSec) => ({ playItemIndex: 0, timeSec, entryMark: true }));
  expect(chapterTimes(marks, duration)).toEqual([...expected]);
});

test('chapterTimes - link points are not chapters', () => {
  expect(chapterTimes([{ playItemIndex: 0, timeSec: 10, entryMark: false }], 100)).toEqual([]);
});

test.each([
  [0x1b, 'h264'],
  [0x24, 'hevc'],
  [0xea, 'vc1'],
  [0x02, 'mpeg2video'],
  [0x80, 'pcm_bluray'],
  [0x83, 'truehd'],
  [0x84, 'eac3'],
  [0x86, 'dts'],
  [0x90, 'hdmv_pgs_subtitle'],
  [0x99, '0x99'],
])('codecForCodingType - 0x%s', (codingType, codec) => {
  expect(codecForCodingType(codingType)).toBe(codec);
});

test('parseClpi - duration from STC sequences and program streams with languages', () => {
  const bytes = writeClpi({
    stc: [
      { start: IN, end: IN + 3000 * T },
      { start: 0, end: 600 * T },
    ],
    streams: [
      { pid: 0x1011, codingType: 0x1b },
      { pid: 0x1100, codingType: 0x83, language: 'spa' },
      { pid: 0x1200, codingType: 0x90, language: 'eng' },
    ],
  });
  expect(parseClpi('00001', bytes)).toEqual({
    clipId: '00001',
    durationSec: 3600,
    streams: [
      { pid: 0x1011, codingType: 0x1b, codec: 'h264', language: null },
      { pid: 0x1100, codingType: 0x83, codec: 'truehd', language: 'spa' },
      { pid: 0x1200, codingType: 0x90, codec: 'hdmv_pgs_subtitle', language: 'eng' },
    ],
  });
});

test('parseClpi - presentation time wrapping past 2^32 ticks', () => {
  const bytes = writeClpi({ stc: [{ start: 2 ** 32 - 45_000, end: 45_000 }] });
  expect(parseClpi('00002', bytes).durationSec).toBe(2);
});

test('parseClpi - no STC sequence means unknown duration', () => {
  expect(parseClpi('00003', writeClpi({})).durationSec).toBeNull();
});

test('parseClpi - rejects files without the HDMV magic', () => {
  expect(() => parseClpi('00004', writeMpls({ playItems: [] }))).toThrow('not a CLPI file');
});

test('withClipLanguages - fills only missing languages by PID', () => {
  const playlist = parseMpls(
    '00800.mpls',
    writeMpls({
      playItems: [
        {
          clipId: '00001',
          inTime: 0,
          outTime: T,
          stn: {
            audio: [
              { pid: 0x1100, codingType: 0x81, language: 'und' },
              { pid: 0x1101, codingType: 0x81, language: 'eng' },
            ],
          },
        },
      ],
    }),
  );
  const clip = parseClpi(
    '00001',
    writeClpi({
      streams: [
        { pid: 0x1100, codingType: 0x81, language: 'spa' },
        { pid: 0x1101, codingType: 0x81, language: 'fre' },
      ],
    }),
  );
  expect(withClipLanguages(playlist, clip).streams.map((s) => s.language)).toEqual(['spa', 'eng']);
});
