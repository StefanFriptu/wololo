import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../core/errors.ts';
import { copyOwnership, NODE_REPLACE_FS, type ReplaceFs, replaceOriginal } from './replace.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function files(): { source: string; temp: string; mkv: string } {
  dir = mkdtempSync(join(tmpdir(), 'wololo-replace-'));
  const source = join(dir, 'Movie.mp4');
  const temp = join(dir, 'Movie.wololo-tmp.mkv');
  writeFileSync(source, 'old');
  writeFileSync(temp, 'new');
  return { source, temp, mkv: join(dir, 'Movie.mkv') };
}

function fakeStats(uid: number, gid: number, mode = 0o100640): Stats {
  return { uid, gid, mode } as Stats;
}

function recordingFs(overrides: Partial<ReplaceFs> = {}): { fs: ReplaceFs; calls: string[] } {
  const calls: string[] = [];
  const wrap =
    <K extends keyof ReplaceFs>(name: K) =>
    (...args: Parameters<ReplaceFs[K]>) => {
      calls.push(`${name} ${args.join(' ')}`);
      const impl = (overrides[name] ?? NODE_REPLACE_FS[name]) as (...inner: Parameters<ReplaceFs[K]>) => unknown;
      return impl(...args);
    };
  const fs = {
    stat: wrap('stat'),
    exists: wrap('exists'),
    chmod: wrap('chmod'),
    chown: wrap('chown'),
    fsync: wrap('fsync'),
    link: wrap('link'),
    rename: wrap('rename'),
    unlink: wrap('unlink'),
  } as ReplaceFs;
  return { fs, calls };
}

test('copyOwnership - copies the mode and chowns to the source owner when they differ', () => {
  const calls: string[] = [];
  const fs: ReplaceFs = {
    ...NODE_REPLACE_FS,
    chmod: (path, mode) => calls.push(`chmod ${path} ${mode.toString(8)}`),
    stat: () => fakeStats(0, 0),
    chown: (path, uid, gid) => calls.push(`chown ${path} ${uid}:${gid}`),
  };

  expect(copyOwnership(fs, fakeStats(1000, 100), '/m/t.mkv')).toBeNull();
  expect(calls).toEqual(['chmod /m/t.mkv 640', 'chown /m/t.mkv 1000:100']);
});

test('copyOwnership - skips chown when the owner already matches', () => {
  const calls: string[] = [];
  const fs: ReplaceFs = {
    ...NODE_REPLACE_FS,
    chmod: () => {},
    stat: () => fakeStats(1000, 100),
    chown: () => calls.push('chown'),
  };

  expect(copyOwnership(fs, fakeStats(1000, 100), '/m/t.mkv')).toBeNull();
  expect(calls).toEqual([]);
});

test('copyOwnership - a refused chown is reported as a warning, not thrown', () => {
  const fs: ReplaceFs = {
    ...NODE_REPLACE_FS,
    chmod: () => {},
    stat: () => fakeStats(501, 20),
    chown: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
  };

  expect(copyOwnership(fs, fakeStats(1000, 100), '/m/t.mkv')).toBe(
    'could not keep owner 1000:100 (operation not permitted)',
  );
});

test('replaceOriginal - flushes the temp file before the swap and the folder after it', async () => {
  const { source, temp } = files();
  const inPlace = join(dir, 'Movie.mkv');
  writeFileSync(inPlace, 'old');
  const { fs, calls } = recordingFs();

  await replaceOriginal({
    sourcePath: inPlace,
    tempPath: temp,
    outputPath: inPlace,
    recycle: null,
    fs,
    warn: () => {},
  });

  const order = calls.filter((call) => /^(fsync|rename)/.test(call));
  expect(order).toEqual([`fsync ${temp}`, `rename ${temp} ${inPlace}`, `fsync ${dir}`]);
  expect(readFileSync(inPlace, 'utf8')).toBe('new');
  expect(readFileSync(source, 'utf8')).toBe('old');
});

test('replaceOriginal - a new output path is created by link + unlink and the old source is removed', async () => {
  const { source, temp, mkv } = files();
  const { fs, calls } = recordingFs();

  await replaceOriginal({ sourcePath: source, tempPath: temp, outputPath: mkv, recycle: null, fs, warn: () => {} });

  expect(calls.some((call) => call.startsWith('rename'))).toBe(false);
  expect(readdirSync(dir)).toEqual(['Movie.mkv']);
  expect(readFileSync(mkv, 'utf8')).toBe('new');
});

test('replaceOriginal - an output that appears after the check is never overwritten (EEXIST)', async () => {
  const { source, temp, mkv } = files();
  const { fs } = recordingFs({
    exists: (path) => path !== mkv && NODE_REPLACE_FS.exists(path),
    link: (from, to) => {
      writeFileSync(mkv, 'foreign');
      NODE_REPLACE_FS.link(from, to);
    },
  });

  const error = await replaceOriginal({
    sourcePath: source,
    tempPath: temp,
    outputPath: mkv,
    recycle: null,
    fs,
    warn: () => {},
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('conflict');
  expect(readFileSync(mkv, 'utf8')).toBe('foreign');
  expect(readFileSync(source, 'utf8')).toBe('old');
  expect(readFileSync(temp, 'utf8')).toBe('new');
});

const noLinks: Partial<ReplaceFs> = {
  link: () => {
    throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
  },
};

test('replaceOriginal - without hard links a new output path is created by rename', async () => {
  const { source, temp, mkv } = files();
  const { fs } = recordingFs(noLinks);

  await replaceOriginal({ sourcePath: source, tempPath: temp, outputPath: mkv, recycle: null, fs, warn: () => {} });

  expect(readdirSync(dir)).toEqual(['Movie.mkv']);
  expect(readFileSync(mkv, 'utf8')).toBe('new');
});

test('replaceOriginal - without hard links an output that appears after the first check is not overwritten', async () => {
  const { source, temp, mkv } = files();
  let checks = 0;
  const { fs } = recordingFs({
    ...noLinks,
    exists: (path) => (path === mkv && checks++ === 0 ? false : NODE_REPLACE_FS.exists(path)),
  });
  writeFileSync(mkv, 'foreign');

  await expect(
    replaceOriginal({ sourcePath: source, tempPath: temp, outputPath: mkv, recycle: null, fs, warn: () => {} }),
  ).rejects.toThrow('output path appeared during the job');

  expect(readFileSync(mkv, 'utf8')).toBe('foreign');
  expect(readFileSync(source, 'utf8')).toBe('old');
});

test('replaceOriginal - the source keeps its permission bits on the new file', async () => {
  const { temp } = files();
  const inPlace = join(dir, 'Movie.mkv');
  writeFileSync(inPlace, 'old', { mode: 0o604 });
  const warnings: string[] = [];

  await replaceOriginal({
    sourcePath: inPlace,
    tempPath: temp,
    outputPath: inPlace,
    recycle: null,
    fs: NODE_REPLACE_FS,
    warn: (message) => warnings.push(message),
  });

  expect(statSync(inPlace).mode & 0o777).toBe(0o604);
  expect(warnings).toEqual([]);
});
