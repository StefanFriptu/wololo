import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '../../db/client.ts';
import {
  applyPendingRestore,
  CONFIG_FILE,
  DATABASE_FILE,
  RESTORE_DIR,
  RESTORE_STAGING_PREFIX,
  scrubRestoredDatabase,
  validateRestoreFiles,
} from './restore.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wololo-restore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function migratedDatabase(path: string): number {
  const handle = openDatabase(path);
  runMigrations(handle);
  const row = handle.sqlite.query('SELECT MAX(created_at) AS latest FROM __drizzle_migrations').get() as {
    latest: number;
  };
  handle.sqlite.run('PRAGMA journal_mode = DELETE');
  handle.close();
  return row.latest;
}

test('applyPendingRestore - nothing staged returns false and leaves files alone', () => {
  writeFileSync(join(dir, CONFIG_FILE), '{"port":1}');
  expect(applyPendingRestore(dir)).toBe(false);
  expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe('{"port":1}');
});

test('applyPendingRestore - a missing config dir returns false', () => {
  expect(applyPendingRestore(join(dir, 'missing'))).toBe(false);
});

test('applyPendingRestore - swaps in database and config, drops the old WAL files and the staging dir', () => {
  writeFileSync(join(dir, DATABASE_FILE), 'old db');
  writeFileSync(join(dir, `${DATABASE_FILE}-wal`), 'old wal');
  writeFileSync(join(dir, `${DATABASE_FILE}-shm`), 'old shm');
  writeFileSync(join(dir, CONFIG_FILE), 'old config');
  mkdirSync(join(dir, RESTORE_DIR));
  writeFileSync(join(dir, RESTORE_DIR, DATABASE_FILE), 'new db');
  writeFileSync(join(dir, RESTORE_DIR, CONFIG_FILE), 'new config');

  expect(applyPendingRestore(dir)).toBe(true);
  expect(readFileSync(join(dir, DATABASE_FILE), 'utf8')).toBe('new db');
  expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe('new config');
  expect(existsSync(join(dir, `${DATABASE_FILE}-wal`))).toBe(false);
  expect(existsSync(join(dir, `${DATABASE_FILE}-shm`))).toBe(false);
  expect(existsSync(join(dir, RESTORE_DIR))).toBe(false);
});

test('applyPendingRestore - a database-only restore keeps the current config', () => {
  writeFileSync(join(dir, CONFIG_FILE), 'current config');
  mkdirSync(join(dir, RESTORE_DIR));
  writeFileSync(join(dir, RESTORE_DIR, DATABASE_FILE), 'new db');
  expect(applyPendingRestore(dir)).toBe(true);
  expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toBe('current config');
  expect(readFileSync(join(dir, DATABASE_FILE), 'utf8')).toBe('new db');
});

test('applyPendingRestore - removes abandoned staging dirs', () => {
  const staging = join(dir, `${RESTORE_STAGING_PREFIX}abc`);
  mkdirSync(staging);
  writeFileSync(join(staging, DATABASE_FILE), 'partial');
  expect(applyPendingRestore(dir)).toBe(false);
  expect(existsSync(staging)).toBe(false);
});

test('validateRestoreFiles - accepts a migrated Wololo database with a JSON config', () => {
  const latest = migratedDatabase(join(dir, DATABASE_FILE));
  writeFileSync(join(dir, CONFIG_FILE), '{"apiKey":"0123456789abcdef"}');
  expect(validateRestoreFiles(dir, latest)).toEqual({ ok: true });
});

test('validateRestoreFiles - config.json is optional', () => {
  const latest = migratedDatabase(join(dir, DATABASE_FILE));
  expect(validateRestoreFiles(dir, latest)).toEqual({ ok: true });
});

test('validateRestoreFiles - refuses a backup made by a newer version', () => {
  const latest = migratedDatabase(join(dir, DATABASE_FILE));
  const result = validateRestoreFiles(dir, latest - 1);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining('newer Wololo version') });
});

test.each([
  ['missing database', () => undefined, 'has no wololo.db'],
  ['not SQLite', () => writeFileSync(join(dir, DATABASE_FILE), 'definitely not sqlite'), 'not a readable SQLite'],
  [
    'foreign SQLite database',
    () => {
      const db = new Database(join(dir, DATABASE_FILE));
      db.run('CREATE TABLE notes (id INTEGER)');
      db.close();
    },
    'not a Wololo database',
  ],
])('validateRestoreFiles - rejects %s', (_label, arrange, reason) => {
  arrange();
  const result = validateRestoreFiles(dir, Number.MAX_SAFE_INTEGER);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining(reason) });
});

test.each([['not json'], ['[1,2]'], ['null']])('validateRestoreFiles - rejects config.json %p', (content) => {
  migratedDatabase(join(dir, DATABASE_FILE));
  writeFileSync(join(dir, CONFIG_FILE), content);
  expect(validateRestoreFiles(dir, Number.MAX_SAFE_INTEGER)).toEqual({
    ok: false,
    reason: 'config.json is not a JSON object',
  });
});

test('scrubRestoredDatabase - drops job file pointers and retires recycle rows outside a recycle stamp folder', () => {
  const path = join(dir, DATABASE_FILE);
  migratedDatabase(path);
  const seed = new Database(path, { strict: true });
  seed.run(
    "INSERT INTO jobs (id, type, trigger, title, source_path, log_path, temp_path) VALUES (1, 'audio', 'manual', 'A', '/m/a.mkv', '/config/config.json', '/proc/self/environ')",
  );
  const insertBin = seed.query(
    "INSERT INTO recycle_bin (id, original_path, recycle_path, size_bytes, expires_at) VALUES ($id, $original, $recycle, 1, '2030-01-01T00:00:00.000Z')",
  );
  insertBin.run({ id: 1, original: '/m/a.mkv', recycle: '/m/.wololo-recycle/20261115T103005Z/a.mkv' });
  insertBin.run({ id: 2, original: '/m/b.mkv', recycle: '/config/config.json' });
  insertBin.run({ id: 3, original: '/m/x/../c.mkv', recycle: '/m/.wololo-recycle/20261115T103005Z/c.mkv' });
  seed.close();

  expect(scrubRestoredDatabase(path, new Date('2026-11-16T00:00:00.000Z'))).toEqual({ ok: true });

  const check = new Database(path, { readonly: true });
  expect(check.query('SELECT log_path, temp_path FROM jobs').all()).toEqual([{ log_path: null, temp_path: null }]);
  expect(check.query('SELECT id, purged_at FROM recycle_bin ORDER BY id').all()).toEqual([
    { id: 1, purged_at: null },
    { id: 2, purged_at: '2026-11-16T00:00:00.000Z' },
    { id: 3, purged_at: '2026-11-16T00:00:00.000Z' },
  ]);
  check.close();
});

test('scrubRestoredDatabase - rejects a database without Wololo tables', () => {
  const path = join(dir, DATABASE_FILE);
  const db = new Database(path);
  db.run('CREATE TABLE __drizzle_migrations (id INTEGER, created_at INTEGER)');
  db.close();
  expect(scrubRestoredDatabase(path, new Date())).toEqual({
    ok: false,
    reason: expect.stringContaining('missing Wololo tables'),
  });
});
