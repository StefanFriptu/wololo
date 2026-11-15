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
