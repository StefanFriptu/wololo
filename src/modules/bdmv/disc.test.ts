import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDiscFolder } from '../../../test/fixtures/bdmv/disc.ts';
import { writeMpls } from '../../../test/fixtures/bdmv/writers.ts';
import { analyzeDisc, clipBytes, detectDisc, openDisc, parseDiscTitle } from './disc.ts';
import { createIsoReader, type DiscEntry } from './iso.ts';

const T = 45_000;
const scratch = mkdtempSync(join(tmpdir(), 'wololo-disc-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const noIso = createIsoReader({
  sevenZip: '7z',
  run: async () => {
    throw new Error('7z must not run for folders');
  },
  tempRoot: scratch,
});

const FEATURE = {
  playItems: [
    {
      clipId: '00001',
      inTime: 0,
      outTime: 5706 * T,
      stn: {
        video: [{ pid: 0x1011, codingType: 0x1b }],
        audio: [{ pid: 0x1100, codingType: 0x86, language: 'und' }],
        pg: [{ pid: 0x1200, codingType: 0x90, language: 'eng' }],
      },
    },
  ],
  marks: [
    { playItem: 0, time: 0 },
    { playItem: 0, time: 600 * T },
  ],
};

test('detectDisc - folder with BDMV/index.bdmv, the BDMV folder itself, an .iso, and other paths', async () => {
  const disc = writeDiscFolder(join(scratch, 'Jamon.Jamon.1992'), { playlists: { '00800.mpls': FEATURE } });
  writeFileSync(join(scratch, 'Movie.ISO'), 'x');
  writeFileSync(join(scratch, 'movie.mkv'), 'x');
  mkdirSync(join(scratch, 'empty'), { recursive: true });
  expect(await detectDisc(disc)).toEqual({ kind: 'bdmv', discRoot: disc });
  expect(await detectDisc(join(disc, 'BDMV'))).toEqual({ kind: 'bdmv', discRoot: disc });
  expect(await detectDisc(join(scratch, 'Movie.ISO'))).toEqual({ kind: 'iso', discRoot: join(scratch, 'Movie.ISO') });
  expect(await detectDisc(join(scratch, 'movie.mkv'))).toBeNull();
  expect(await detectDisc(join(scratch, 'empty'))).toBeNull();
  expect(await detectDisc(join(scratch, 'missing'))).toBeNull();
});

test('analyzeDisc - parses playlists, fills languages from CLPI, picks the main title and reads the disc title', async () => {
  const disc = writeDiscFolder(join(scratch, 'analyze'), {
    playlists: {
      '00800.mpls': FEATURE,
      '00801.mpls': FEATURE,
      '00010.mpls': { playItems: [{ clipId: '00010', inTime: 0, outTime: 300 * T }] },
    },
    clips: {
      '00001': { streams: [{ pid: 0x1100, codingType: 0x86, language: 'spa' }], streamBytes: 4000 },
      '00010': { streamBytes: 1000 },
    },
    files: {
      'BDMV/PLAYLIST/00999.mpls': 'garbage!',
      'BDMV/META/DL/bdmt_eng.xml': '<di:discinfo><di:title><di:name>JAMON JAMON</di:name></di:title></di:discinfo>',
    },
  });
  const source = await openDisc(disc, 'bdmv', noIso);
  const analysis = await analyzeDisc(source, { ambiguityPercent: 5, extrasMinMinutes: 2 });
  expect(analysis.encryption).toEqual({ encrypted: false, markers: [] });
  expect(analysis.playlists.map((p) => p.name).sort()).toEqual(['00010.mpls', '00800.mpls', '00801.mpls']);
  expect(analysis.parseErrors).toHaveLength(1);
  expect(analysis.duplicateOf).toEqual({ '00801.mpls': '00800.mpls' });
  expect(analysis.pick.main?.name).toBe('00800.mpls');
  expect(analysis.pick.main?.streams.find((s) => s.kind === 'audio')?.language).toBe('spa');
  expect(analysis.pick.main?.chapterTimesSec).toEqual([0, 600]);
  expect(analysis.pick.extras.map((p) => p.name)).toEqual(['00010.mpls']);
  expect(analysis.volumeLabel).toBe('JAMON JAMON');
  expect(clipBytes(source.entries, analysis.playlists.slice(0, 1), false)).toBeGreaterThan(0);
});

test('analyzeDisc - encryption markers at the disc root', async () => {
  const disc = writeDiscFolder(join(scratch, 'encrypted'), {
    playlists: { '00800.mpls': FEATURE },
    files: { 'AACS/Unit_Key_RO.inf': 'k', 'BDSVM/00000.svm': 's' },
  });
  const analysis = await analyzeDisc(await openDisc(disc, 'bdmv', noIso), {
    ambiguityPercent: 5,
    extrasMinMinutes: null,
  });
  expect(analysis.encryption).toEqual({ encrypted: true, markers: ['AACS/Unit_Key_RO.inf', 'BDSVM/'] });
});

test('openDisc - iso goes through the 7z reader', async () => {
  const entries: DiscEntry[] = [{ path: 'BDMV/PLAYLIST/00800.mpls', sizeBytes: 10, directory: false }];
  const reads: string[][] = [];
  const source = await openDisc('/x.iso', 'iso', {
    ...noIso,
    entries: async () => entries,
    readFiles: async (_iso, paths) => {
      reads.push([...paths]);
      return new Map(paths.map((path) => [path, writeMpls(FEATURE)]));
    },
  });
  const analysis = await analyzeDisc(source, { ambiguityPercent: 5, extrasMinMinutes: null });
  expect(analysis.pick.main?.name).toBe('00800.mpls');
  expect(reads[0]).toEqual(['BDMV/PLAYLIST/00800.mpls']);
});

test.each([
  ['<di:name>Movie</di:name>', 'Movie'],
  ['<di:name>  Spaced  </di:name>', 'Spaced'],
  ['<di:name></di:name>', null],
  ['<xml/>', null],
])('parseDiscTitle - %s', (xml, title) => {
  expect(parseDiscTitle(xml)).toBe(title);
});

test('clipBytes - counts each clip once and angles only when asked', () => {
  const entries: DiscEntry[] = [
    { path: 'BDMV/STREAM/00001.m2ts', sizeBytes: 100, directory: false },
    { path: 'BDMV/STREAM/00002.m2ts', sizeBytes: 10, directory: false },
  ];
  const item = (clipId: string, angleClipIds: string[] = []) => ({
    clipId,
    inTime: 0,
    outTime: 1,
    durationSec: 1,
    angleClipIds,
    connectionCondition: 1,
  });
  const playlist = {
    name: '00001.mpls',
    durationSec: 2,
    playItems: [item('00001', ['00002']), item('00001')],
    streams: [],
    marks: [],
    chapterTimesSec: [],
  };
  expect(clipBytes(entries, [playlist, playlist], false)).toBe(100);
  expect(clipBytes(entries, [playlist], true)).toBe(110);
});
