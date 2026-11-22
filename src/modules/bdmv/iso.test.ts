import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeMpls } from '../../../test/fixtures/bdmv/writers.ts';
import type { RunOptions, RunResult } from '../../core/process.ts';
import { createIsoReader, findEntry, muxFilesForPlaylist, parseSevenZipListing } from './iso.ts';

const LISTING = `
7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20

Scanning the drive for archives:
1 file, 1048576 bytes (1024 KiB)

Listing archive: /data/Movie.iso

--
Path = /data/Movie.iso
Type = Udf
Physical Size = 1048576
Comment = MOVIE_DISC

----------
Path = BDMV
Folder = +
Size = 0
Modified = 2026-01-01 00:00:00

Path = BDMV/index.bdmv
Folder = -
Size = 278
Modified = 2026-01-01 00:00:00

Path = BDMV/PLAYLIST/00800.mpls
Folder = -
Size = 1024

Path = BDMV/STREAM/00001.m2ts
Folder = -
Size = 25000000000

Path = BDMV/CLIPINF/00001.clpi
Attributes = A
Size = 512

Path = CERTIFICATE
Attributes = D
Size = 0
`;

test('parseSevenZipListing - items after the separator with sizes and folder flags', () => {
  expect(parseSevenZipListing(LISTING)).toEqual([
    { path: 'BDMV', sizeBytes: 0, directory: true },
    { path: 'BDMV/index.bdmv', sizeBytes: 278, directory: false },
    { path: 'BDMV/PLAYLIST/00800.mpls', sizeBytes: 1024, directory: false },
    { path: 'BDMV/STREAM/00001.m2ts', sizeBytes: 25_000_000_000, directory: false },
    { path: 'BDMV/CLIPINF/00001.clpi', sizeBytes: 512, directory: false },
    { path: 'CERTIFICATE', sizeBytes: 0, directory: true },
  ]);
});

test('parseSevenZipListing - windows separators and CRLF', () => {
  const output = '----------\r\nPath = BDMV\\PLAYLIST\\00001.mpls\r\nSize = 10\r\n\r\nPath = AACS\r\nFolder = +\r\n';
  expect(parseSevenZipListing(output)).toEqual([
    { path: 'BDMV/PLAYLIST/00001.mpls', sizeBytes: 10, directory: false },
    { path: 'AACS', sizeBytes: 0, directory: true },
  ]);
});

test('parseSevenZipListing - output without items', () => {
  expect(parseSevenZipListing('Listing archive: x.iso\n')).toEqual([]);
});

test('findEntry - case-insensitive match keeps the original case', () => {
  const entries = parseSevenZipListing(LISTING);
  expect(findEntry(entries, 'bdmv/playlist/00800.MPLS')?.path).toBe('BDMV/PLAYLIST/00800.mpls');
  expect(findEntry(entries, 'BDMV/PLAYLIST/00001.mpls')).toBeNull();
});

test('muxFilesForPlaylist - index, playlist, unique clips and streams', () => {
  expect(muxFilesForPlaylist(['00001', '00002', '00001'], '00800.mpls')).toEqual([
    'BDMV/index.bdmv',
    'BDMV/MovieObject.bdmv',
    'BDMV/PLAYLIST/00800.mpls',
    'BDMV/CLIPINF/00001.clpi',
    'BDMV/CLIPINF/00002.clpi',
    'BDMV/STREAM/00001.m2ts',
    'BDMV/STREAM/00002.m2ts',
  ]);
});

const scratch = mkdtempSync(join(tmpdir(), 'wololo-iso-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MPLS = writeMpls({
  playItems: [
    { clipId: '00001', inTime: 0, outTime: 45_000 },
    { clipId: '00002', inTime: 0, outTime: 45_000, angleClipIds: ['00003'] },
  ],
});

const FILES: Record<string, Uint8Array> = {
  'BDMV/index.bdmv': new Uint8Array([1]),
  'BDMV/PLAYLIST/00800.mpls': MPLS,
  'BDMV/CLIPINF/00001.clpi': new Uint8Array([2]),
  'BDMV/STREAM/00001.m2ts': new Uint8Array([3]),
  'BDMV/STREAM/00002.m2ts': new Uint8Array([4]),
  'BDMV/STREAM/00003.m2ts': new Uint8Array([5]),
};

const FAKE_LISTING = `----------\n${Object.entries(FILES)
  .map(([path, bytes]) => `Path = ${path}\nFolder = -\nSize = ${bytes.length}\n`)
  .join('\n')}`;

function result(argv: string[], stdout = '', exitCode = 0): RunResult {
  return { argv, exitCode, signalCode: null, stdout, stderr: '', durationMs: 1, aborted: false, timedOut: false };
}

/** Behaves like 7z for `l -slt` and `x -o<dir> <iso> @list`. */
function fakeSevenZip(calls: string[][]) {
  return async (options: RunOptions): Promise<RunResult> => {
    const argv = [options.command, ...options.args];
    calls.push(options.args);
    if (options.args[0] === 'l') return result(argv, FAKE_LISTING);
    const dest = options.args.find((arg) => arg.startsWith('-o'))?.slice(2) ?? '';
    const list = options.args.find((arg) => arg.startsWith('@'))?.slice(1) ?? '';
    for (const path of readFileSync(list, 'utf8').split('\n').filter(Boolean)) {
      const bytes = FILES[path];
      if (!bytes) continue;
      mkdirSync(dirname(join(dest, path)), { recursive: true });
      writeFileSync(join(dest, path), bytes);
    }
    return result(argv);
  };
}

test('createIsoReader - list returns files only', async () => {
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip([]), tempRoot: scratch });
  expect(await reader.list('/x.iso')).toEqual(Object.keys(FILES));
});

test('createIsoReader - readFile extracts one file and cleans up its temp dir', async () => {
  const calls: string[][] = [];
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip(calls), tempRoot: scratch });
  expect(await reader.readFile('/x.iso', 'bdmv/index.bdmv')).toEqual(new Uint8Array([1]));
  expect(calls.map((args) => args[0])).toEqual(['l', 'x']);
  expect(readdirSync(scratch)).toEqual([]);
});

test('createIsoReader - readFile of a missing file is not_found', async () => {
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip([]), tempRoot: scratch });
  await expect(reader.readFile('/x.iso', 'BDMV/nope.bin')).rejects.toThrow('not found');
});

test('createIsoReader - readFiles extracts many files in one 7z call', async () => {
  const calls: string[][] = [];
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip(calls), tempRoot: scratch });
  const files = await reader.readFiles('/x.iso', ['BDMV/index.bdmv', 'BDMV/STREAM/00001.m2ts', 'BDMV/missing']);
  expect([...files.keys()]).toEqual(['BDMV/index.bdmv', 'BDMV/STREAM/00001.m2ts']);
  expect(calls.filter((args) => args[0] === 'x')).toHaveLength(1);
});

test('createIsoReader - extractForMux copies the playlist and its clips (angles included)', async () => {
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip([]), tempRoot: scratch });
  const dest = join(scratch, 'mux');
  const playlistPath = await reader.extractForMux('/x.iso', '00800.mpls', dest, new AbortController().signal);
  expect(playlistPath).toBe(join(dest, 'BDMV/PLAYLIST/00800.mpls'));
  expect(readFileSync(join(dest, 'BDMV/STREAM/00003.m2ts'))).toEqual(Buffer.from([5]));
  expect(readFileSync(join(dest, 'BDMV/CLIPINF/00001.clpi'))).toEqual(Buffer.from([2]));
  rmSync(dest, { recursive: true });
});

test('createIsoReader - extractForMux of an unknown playlist is not_found', async () => {
  const reader = createIsoReader({ sevenZip: '7z', run: fakeSevenZip([]), tempRoot: scratch });
  await expect(reader.extractForMux('/x.iso', '00999.mpls', scratch, new AbortController().signal)).rejects.toThrow(
    '00999.mpls not found',
  );
});

test('createIsoReader - a failing 7z is an upstream error', async () => {
  const reader = createIsoReader({
    sevenZip: '7z',
    run: async (options) => ({ ...result([options.command]), exitCode: 2, stderr: 'Cannot open the file as archive' }),
    tempRoot: scratch,
  });
  await expect(reader.list('/broken.iso')).rejects.toThrow('Cannot open the file as archive');
});

test('createIsoReader - a 7z timeout is reported as a timeout', async () => {
  const reader = createIsoReader({
    sevenZip: '7z',
    run: async (options) => ({ ...result([options.command]), exitCode: null, timedOut: true }),
    tempRoot: scratch,
  });
  await expect(reader.list('/slow.iso')).rejects.toThrow('7z l timed out');
});
