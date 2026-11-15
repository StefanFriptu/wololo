import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasBinary } from '../../../test/helpers/binaries.ts';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary } from '../../../test/helpers/seed.ts';
import { BACKUPS_KEPT } from './backupNames.ts';

let t: TestContext;

beforeAll(() => {
  t = createTestContext();
});

afterAll(() => t.cleanup());

test('cleanupLogs - removes old logs of deleted jobs only', async () => {
  const dir = t.ctx.config.get().jobLogDir;
  const kept = insertJob(t.ctx.db, { sourcePath: '/data/media/movies/a.mkv' });
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const name of [`${kept.id}.txt`, '99901.txt', '99902.txt', 'notes.txt']) writeFileSync(join(dir, name), 'log');
  for (const name of [`${kept.id}.txt`, '99901.txt', 'notes.txt']) utimesSync(join(dir, name), old, old);

  expect(await t.ctx.services.system.cleanupLogs()).toBe('Removed 1 job log older than 30 days');
  expect(readdirSync(dir).sort()).toEqual([`${kept.id}.txt`, '99902.txt', 'notes.txt'].sort());
  expect(await t.ctx.services.system.cleanupLogs()).toBe('Removed 0 job logs older than 30 days');
});

test('health - a reachable library root raises nothing about libraries', async () => {
  const root = join(t.dir, 'media', 'movies');
  mkdirSync(root, { recursive: true });
  insertLibrary(t.ctx.db, { name: 'Reachable', roots: [root] });
  const checks = await t.ctx.services.system.health();
  expect(checks.filter((check) => check.source === 'libraries')).toEqual([]);
  expect(checks.filter((check) => check.source === 'config')).toEqual([]);
});

test('health - disabled libraries are not checked', async () => {
  insertLibrary(t.ctx.db, { name: 'Disabled', enabled: false, roots: [join(t.dir, 'gone')] });
  const checks = await t.ctx.services.system.health();
  expect(checks.some((check) => check.message.includes('"Disabled"'))).toBe(false);
});

test.skipIf(!hasBinary('ffmpeg') || !hasBinary('ffprobe'))(
  'tools - finds the real ffmpeg and ffprobe with versions',
  async () => {
    const tools = await t.ctx.services.system.tools();
    for (const name of ['ffmpeg', 'ffprobe'] as const) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.available).toBe(true);
      expect(tool?.path).toBe(Bun.which(name));
      expect(tool?.version).toMatch(/\S+/);
    }
  },
);

test('createBackup - scheduled backups are pruned to the newest ones', async () => {
  const limit = BACKUPS_KEPT.scheduled as number;
  for (let index = 0; index <= limit; index += 1) await t.ctx.services.system.createBackup('scheduled');
  const scheduled = (await t.ctx.services.system.listBackups()).filter((backup) => backup.kind === 'scheduled');
  expect(scheduled).toHaveLength(limit);
  expect(readdirSync(t.ctx.config.get().backupDir).filter((name) => name.startsWith('.'))).toEqual([]);
});

test('createBackup - removes temp files left by an interrupted backup', async () => {
  const dir = t.ctx.config.get().backupDir;
  mkdirSync(dir, { recursive: true });
  const leftovers = [
    '.wololo_backup_scheduled_2026.11.01_03.00.00.zip.db',
    '.wololo_backup_manual_2026.11.01_03.00.00.zip.partial',
  ];
  for (const name of [...leftovers, '.keep']) writeFileSync(join(dir, name), 'x');
  await t.ctx.services.system.createBackup('manual');
  expect(readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual(['.keep']);
});

test('createBackup - concurrent calls get distinct names', async () => {
  const created = await Promise.all([1, 2, 3].map(() => t.ctx.services.system.createBackup('manual')));
  expect(new Set(created.map((backup) => backup.name)).size).toBe(3);
  for (const backup of created) {
    expect(existsSync(await t.ctx.services.system.backupPath(backup.name))).toBe(true);
  }
});
