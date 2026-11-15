import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiscoveredEntry } from '../../contracts/probe-scan.ts';
import { DEFAULT_SETTINGS } from '../../shared/settings.ts';
import { isIgnored, skipPathsFor } from './eligibility.ts';
import { statEntry } from './entries.ts';
import { type WalkOptions, walkRoot } from './walker.ts';

let root: string;

function file(relativePath: string, bytes = 10): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

const OPTIONS: WalkOptions = {
  extensions: DEFAULT_SETTINGS.media.extensions,
  ignorePatterns: DEFAULT_SETTINGS.media.ignorePatterns,
  discs: true,
};
const RECYCLE = DEFAULT_SETTINGS.recycleBin;

async function walk(options: Partial<WalkOptions> = {}) {
  const report = { unreadable: [] as string[] };
  const entries: DiscoveredEntry[] = [];
  for await (const entry of walkRoot(root, { ...OPTIONS, ...options }, report)) entries.push(entry);
  return { entries, report, relative: entries.map((entry) => entry.path.slice(root.length + 1)) };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wololo-walk-'));
  file('Movie (2020)/Movie (2020).mkv', 100);
  file('Movie (2020)/Movie (2020).nfo');
  file('Movie (2020)/Sample/sample.mkv');
  file('Movie (2020)/movie.sample.mkv');
  file('Movie (2020)/Movie (2020).wololo-tmp.mkv');
  file('Movie (2020)/._Movie (2020).mkv');
  file('.wololo-recycle/old.mkv');
  file('Other/Clip.MP4', 50);
  file('Disc Movie/BDMV/index.bdmv');
  file('Disc Movie/BDMV/STREAM/00001.m2ts', 1000);
  file('Disc Movie/BDMV/STREAM/00002.m2ts', 500);
  file('Disc Movie/CERTIFICATE/id.bdmv');
  file('Broken Disc/BDMV/STREAM/00001.m2ts');
  file('Image/Movie.iso', 2000);
  file('Recycle/x.mkv');
  utimesSync(join(root, 'Disc Movie/BDMV/index.bdmv'), 1_700_000_000, 1_700_000_000);
  symlinkSync(join(root, 'Other/Clip.MP4'), join(root, 'Other/Linked.mkv'));
  symlinkSync(join(root, 'Other'), join(root, 'LinkedDir'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test('walkRoot - finds media files, discs and images; skips ignored, hidden, temp and non-media entries', async () => {
  const { relative } = await walk({ skipPaths: [join(root, 'Recycle')] });
  expect(relative.sort()).toEqual(
    ['Disc Movie', 'Image/Movie.iso', 'Movie (2020)/Movie (2020).mkv', 'Other/Clip.MP4', 'Other/Linked.mkv'].sort(),
  );
});

test('walkRoot - a skip path with a trailing slash still keeps the recycle bin out', async () => {
  const { relative } = await walk({
    skipPaths: skipPathsFor({ recycleBin: { ...RECYCLE, path: `${root}/Recycle/` } }),
  });
  expect(relative).not.toContain('Recycle/x.mkv');
  expect(relative).toContain('Other/Clip.MP4');
});

test('walkRoot - disc entries carry the stream size and index.bdmv mtime', async () => {
  const { entries } = await walk();
  const disc = entries.find((entry) => entry.kind === 'bdmv');
  expect(disc).toEqual({ path: join(root, 'Disc Movie'), kind: 'bdmv', sizeBytes: 1500, mtimeMs: 1_700_000_000_000 });
  expect(entries.find((entry) => entry.kind === 'iso')?.sizeBytes).toBe(2000);
});

test('walkRoot - discs disabled skips disc folders and images', async () => {
  const { entries } = await walk({ discs: false });
  expect(entries.some((entry) => entry.kind !== 'file')).toBe(false);
  expect(entries.length).toBeGreaterThan(0);
});

test('walkRoot - extensions filter', async () => {
  const { relative } = await walk({ extensions: ['.mp4'], discs: false });
  expect(relative).toEqual(['Other/Clip.MP4']);
});

test('walkRoot - an aborted signal yields nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { entries } = await walk({ signal: controller.signal });
  expect(entries).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)('walkRoot - unreadable folders are reported, not fatal', async () => {
  const locked = join(root, 'Locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'x.mkv'), 'x');
  chmodSync(locked, 0o000);
  try {
    const { report, relative } = await walk();
    expect(report.unreadable).toEqual([locked]);
    expect(relative).toContain('Movie (2020)/Movie (2020).mkv');
  } finally {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
  }
});

test('walkRoot - the root itself can be a disc', async () => {
  const discRoot = join(root, 'Disc Movie');
  const report = { unreadable: [] as string[] };
  const entries: DiscoveredEntry[] = [];
  for await (const entry of walkRoot(discRoot, OPTIONS, report)) entries.push(entry);
  expect(entries.map((entry) => entry.kind)).toEqual(['bdmv']);
});

test.each([
  ['Movie/Sample/x.mkv', false, true],
  ['Movie/Sample', true, true],
  ['Movie/x.sample.mkv', false, true],
  ['.wololo-recycle/x.mkv', false, true],
  ['Movie/@eaDir', true, true],
  ['Movie/x.mkv', false, false],
  ['Samples/x.mkv', false, false],
])('isIgnored - %s (dir %p) -> %p', (path, isDirectory, expected) => {
  const globs = DEFAULT_SETTINGS.media.ignorePatterns.map((pattern) => new Bun.Glob(pattern));
  expect(isIgnored(path, isDirectory, globs)).toBe(expected);
});

test('statEntry - files, images, discs, plain folders and missing paths', async () => {
  expect(await statEntry(join(root, 'Other/Clip.MP4'))).toMatchObject({ kind: 'file', sizeBytes: 50 });
  expect(await statEntry(join(root, 'Image/Movie.iso'))).toMatchObject({ kind: 'iso', sizeBytes: 2000 });
  expect(await statEntry(join(root, 'Disc Movie'))).toMatchObject({ kind: 'bdmv', sizeBytes: 1500 });
  expect(await statEntry(join(root, 'Broken Disc'))).toBeNull();
  expect(await statEntry(join(root, 'Other'))).toBeNull();
  expect(await statEntry(join(root, 'missing.mkv'))).toBeNull();
});
