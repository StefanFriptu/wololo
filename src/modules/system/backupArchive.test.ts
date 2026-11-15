import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { extractZipEntries, writeZipArchive } from './backupArchive.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wololo-archive-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < bytes.length; start += size) yield bytes.subarray(start, start + size);
}

function target(): string {
  const out = join(dir, `out-${readdirSync(dir).length}`);
  mkdirSync(out);
  return out;
}

test('writeZipArchive - round trips through extractZipEntries in small chunks', async () => {
  const big = new Uint8Array(3 * 1024 * 1024).map((_, index) => (index * 31) % 251);
  writeFileSync(join(dir, 'a.bin'), big);
  writeFileSync(join(dir, 'b.json'), '{"apiKey":"x"}');
  const zip = join(dir, 'backup.zip');
  await writeZipArchive(zip, [
    { name: 'wololo.db', sourcePath: join(dir, 'a.bin') },
    { name: 'config.json', sourcePath: join(dir, 'b.json') },
  ]);
  const out = target();
  const names = await extractZipEntries(chunked(readFileSync(zip), 4096), out, {
    'wololo.db': 10 * 1024 * 1024,
    'config.json': 1024,
  });
  expect(names.sort()).toEqual(['config.json', 'wololo.db']);
  expect(Buffer.compare(readFileSync(join(out, 'wololo.db')), Buffer.from(big))).toBe(0);
  expect(readFileSync(join(out, 'config.json'), 'utf8')).toBe('{"apiKey":"x"}');
});

test('writeZipArchive - refuses to overwrite an existing file', async () => {
  writeFileSync(join(dir, 'a.bin'), 'a');
  writeFileSync(join(dir, 'exists.zip'), 'keep');
  await expect(
    writeZipArchive(join(dir, 'exists.zip'), [{ name: 'a', sourcePath: join(dir, 'a.bin') }]),
  ).rejects.toThrow();
  expect(readFileSync(join(dir, 'exists.zip'), 'utf8')).toBe('keep');
});

test('extractZipEntries - skips entries that are not listed, including path traversal names', async () => {
  const zip = zipSync({
    'wololo.db': new Uint8Array([1, 2, 3]),
    '../evil.txt': new Uint8Array([4]),
    'x/y': new Uint8Array([5]),
  });
  const out = target();
  expect(await extractZipEntries(chunked(zip, 7), out, { 'wololo.db': 10 })).toEqual(['wololo.db']);
  expect(readdirSync(out)).toEqual(['wololo.db']);
  expect(readdirSync(dir).includes('evil.txt')).toBe(false);
});

test('extractZipEntries - an entry over its byte limit fails', async () => {
  const zip = zipSync({ 'config.json': new Uint8Array(2048) });
  await expect(extractZipEntries(chunked(zip, 512), target(), { 'config.json': 1024 })).rejects.toThrow('larger than');
});

test('extractZipEntries - stored (uncompressed) entries are extracted too', async () => {
  const zip = zipSync({ 'config.json': [new Uint8Array([123, 125]), { level: 0 }] });
  const out = target();
  expect(await extractZipEntries(chunked(zip, 3), out, { 'config.json': 10 })).toEqual(['config.json']);
  expect(readFileSync(join(out, 'config.json'), 'utf8')).toBe('{}');
});

test('extractZipEntries - non-zip input yields no entries', async () => {
  expect(
    await extractZipEntries(chunked(new TextEncoder().encode('not a zip at all'), 4), target(), { 'wololo.db': 10 }),
  ).toEqual([]);
});

test('extractZipEntries - a truncated archive fails', async () => {
  const zip = zipSync({ 'wololo.db': new Uint8Array(100_000).map((_, index) => index % 7) }, { level: 0 });
  await expect(
    extractZipEntries(chunked(zip.subarray(0, 5000), 1000), target(), { 'wololo.db': 1e6 }),
  ).rejects.toThrow();
});
