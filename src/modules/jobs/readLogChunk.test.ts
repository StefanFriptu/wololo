import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLogChunk } from './readLogChunk.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-log-chunk-'));
  dirs.push(dir);
  const path = join(dir, 'job.txt');
  writeFileSync(path, text);
  return path;
}

const bytesOf = (text: string) => Buffer.byteLength(text);

test('readLogChunk - a log within the limit is returned whole', async () => {
  const text = 'one\ntwo\n';
  expect(await readLogChunk(logFile(text), { maxBytes: 100 })).toEqual({ text, start: 0, end: 8, size: 8 });
});

test('readLogChunk - a large log returns only its last whole lines', async () => {
  const text = 'first line\nsecond line\nthird\n';
  const chunk = await readLogChunk(logFile(text), { maxBytes: 12 });
  expect(chunk).toEqual({ text: 'third\n', start: bytesOf('first line\nsecond line\n'), end: bytesOf(text), size: 29 });
});

test('readLogChunk - from continues at that byte with only the appended lines', async () => {
  const text = 'one\ntwo\nthree\n';
  const chunk = await readLogChunk(logFile(text), { from: 4, maxBytes: 100 });
  expect(chunk).toEqual({ text: 'two\nthree\n', start: 4, end: 14, size: 14 });
});

test('readLogChunk - from at the end returns nothing', async () => {
  expect(await readLogChunk(logFile('one\n'), { from: 4, maxBytes: 100 })).toEqual({
    text: '',
    start: 4,
    end: 4,
    size: 4,
  });
});

test('readLogChunk - a line still being written is held back until it ends', async () => {
  const chunk = await readLogChunk(logFile('one\ntw'), { from: 0, maxBytes: 100 });
  expect(chunk).toEqual({ text: 'one\n', start: 0, end: 4, size: 6 });
});

test('readLogChunk - from further back than the limit jumps to the tail', async () => {
  const text = `${'x'.repeat(50)}\nlast\n`;
  const chunk = await readLogChunk(logFile(text), { from: 0, maxBytes: 10 });
  expect(chunk).toEqual({ text: 'last\n', start: 51, end: 56, size: 56 });
});

test('readLogChunk - from past the end of a rewritten log starts at its tail', async () => {
  const chunk = await readLogChunk(logFile('new\n'), { from: 500, maxBytes: 100 });
  expect(chunk).toEqual({ text: 'new\n', start: 0, end: 4, size: 4 });
});

test('readLogChunk - a tail cut through a multibyte character drops that partial line', async () => {
  const text = 'ééééé\nok\n';
  const chunk = await readLogChunk(logFile(text), { maxBytes: 6 });
  expect(chunk.text).toBe('ok\n');
  expect(chunk.text).not.toContain('�');
});
