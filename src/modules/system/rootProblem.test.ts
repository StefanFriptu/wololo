import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootProblem } from './rootProblem.ts';

const dir = mkdtempSync(join(tmpdir(), 'wololo-root-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('rootProblem - a readable directory has no problem', async () => {
  mkdirSync(join(dir, 'movies'));
  expect(await rootProblem(join(dir, 'movies'))).toBeNull();
});

test('rootProblem - a missing path reports its error code', async () => {
  expect(await rootProblem(join(dir, 'missing'))).toBe('ENOENT');
});

test('rootProblem - a file is not a directory', async () => {
  writeFileSync(join(dir, 'file.mkv'), '');
  expect(await rootProblem(join(dir, 'file.mkv'))).toBe('not a directory');
});

test('rootProblem - a stat that never answers times out instead of blocking', async () => {
  const started = performance.now();
  const problem = await rootProblem('/mnt/nas', {
    stat: () => new Promise(() => undefined),
    access: async () => undefined,
    timeoutMs: 20,
  });
  expect(problem).toBe('no answer within 0.02 s (hung mount?)');
  expect(performance.now() - started).toBeLessThan(1000);
});

test('rootProblem - an unreadable directory reports the access error', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const problem = await rootProblem('/data/movies', {
    stat: async () => ({ isDirectory: () => true }),
    access: async () => {
      throw denied;
    },
    timeoutMs: 1000,
  });
  expect(problem).toBe('EACCES');
});
