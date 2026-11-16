import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../core/errors.ts';
import { type BinTrialFs, checkRecycleBinLocation, NODE_BIN_TRIAL_FS } from './checkRecycleBinLocation.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function library() {
  const root = mkdtempSync(join(tmpdir(), 'wololo-bin-check-'));
  dirs.push(root);
  const folder = join(root, 'Movie (2020)');
  mkdirSync(folder);
  const source = join(folder, 'Movie (2020).mkv');
  writeFileSync(source, 'original');
  return { root, folder, source, bin: join(root, '.wololo-recycle') };
}

const failWith = (code: string) => () => {
  throw Object.assign(new Error(`${code}: refused`), { code });
};

function check(source: string, root: string, trialFs?: BinTrialFs) {
  return checkRecycleBinLocation(
    {
      configuredPath: null,
      findRootForPath: async () => ({ library: {} as never, rootId: 1, rootPath: root }),
      warn: () => {},
      trialFs,
    },
    source,
  );
}

async function precondition(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('precondition_failed');
  return (error as AppError).message;
}

test('checkRecycleBinLocation - the real trial passes on one filesystem and leaves no probe behind', async () => {
  const s = library();

  expect(await check(s.source, s.root, NODE_BIN_TRIAL_FS)).toEqual({ binRoot: s.bin, rootPath: s.root });

  expect(readdirSync(s.bin)).toEqual([]);
  expect(readdirSync(s.folder)).toEqual(['Movie (2020).mkv']);
});

test('checkRecycleBinLocation - a bin that refuses links across mounts (EXDEV) fails before encoding', async () => {
  const s = library();

  const message = await precondition(check(s.source, s.root, { ...NODE_BIN_TRIAL_FS, link: failWith('EXDEV') }));

  expect(message).toContain('cannot share files with');
  expect(message).toContain('EXDEV');
  expect(readdirSync(s.bin)).toEqual([]);
});

test('checkRecycleBinLocation - no hard links but a working rename passes, as the replace step moves instead', async () => {
  const s = library();
  const renames: string[][] = [];
  const trialFs: BinTrialFs = {
    ...NODE_BIN_TRIAL_FS,
    link: failWith('EPERM'),
    rename: (from, to) => {
      renames.push([from, to]);
      NODE_BIN_TRIAL_FS.rename(from, to);
    },
  };

  await check(s.source, s.root, trialFs);

  expect(renames).toHaveLength(2);
  expect(renames[0]?.[1]?.startsWith(`${s.folder}/.wololo-probe-`)).toBe(true);
  expect(readdirSync(s.bin)).toEqual([]);
  expect(readdirSync(s.folder)).toEqual(['Movie (2020).mkv']);
});

test('checkRecycleBinLocation - no hard links and a rename that crosses mounts fails and removes the probe', async () => {
  const s = library();

  const message = await precondition(
    check(s.source, s.root, { ...NODE_BIN_TRIAL_FS, link: failWith('EPERM'), rename: failWith('EXDEV') }),
  );

  expect(message).toContain('EXDEV');
  expect(readdirSync(s.bin)).toEqual([]);
  expect(readdirSync(s.folder)).toEqual(['Movie (2020).mkv']);
});

test('checkRecycleBinLocation - without a trial fs only the cheap checks run', async () => {
  const s = library();

  expect(await check(s.source, s.root)).toEqual({ binRoot: s.bin, rootPath: s.root });
});
