import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isNormalizedAbsolutePath, isRecyclePath } from '../recycle-bin/paths.ts';

export const DATABASE_FILE = 'wololo.db';
export const CONFIG_FILE = 'config.json';
/** Holds a validated restore until the next start; created by an atomic rename, so its presence means complete. */
export const RESTORE_DIR = 'restore';
export const RESTORE_STAGING_PREFIX = 'restore.staging-';

const DATABASE_SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

/**
 * Called by bootstrap BEFORE ConfigStore, the logger and the database open, so a restored config.json (API key, port,
 * URL base) and wololo.db take effect in the same start. Applies a restore staged by SystemService.restoreBackup
 * (<configDir>/restore/ with wololo.db and optionally config.json) and returns true when it did. Each step is a rename
 * inside the config dir, so a crash part-way leaves the rest staged for the next start.
 */
export function applyPendingRestore(configDir: string): boolean {
  if (!existsSync(configDir)) return false;
  for (const name of readdirSync(configDir)) {
    if (name.startsWith(RESTORE_STAGING_PREFIX)) rmSync(join(configDir, name), { recursive: true, force: true });
  }
  const staged = join(configDir, RESTORE_DIR);
  if (!existsSync(staged)) return false;

  const database = join(staged, DATABASE_FILE);
  if (existsSync(database)) {
    for (const suffix of DATABASE_SIDE_FILES) rmSync(join(configDir, `${DATABASE_FILE}${suffix}`), { force: true });
    renameSync(database, join(configDir, DATABASE_FILE));
  }
  const config = join(staged, CONFIG_FILE);
  if (existsSync(config)) renameSync(config, join(configDir, CONFIG_FILE));
  rmSync(staged, { recursive: true, force: true });
  return true;
}

export type RestoreValidation = { ok: true } | { ok: false; reason: string };

function validateConfig(path: string): RestoreValidation {
  if (!existsSync(path)) return { ok: true };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true };
  } catch {}
  return { ok: false, reason: `${CONFIG_FILE} is not a JSON object` };
}

function validateDatabase(path: string, latestMigrationMillis: number): RestoreValidation {
  if (!existsSync(path)) return { ok: false, reason: `the archive has no ${DATABASE_FILE}` };
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(path, { readonly: true });
    const check = sqlite.query('PRAGMA quick_check').get() as { quick_check?: string } | null;
    if (check?.quick_check !== 'ok') return { ok: false, reason: `${DATABASE_FILE} failed the integrity check` };
    const table = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!table) return { ok: false, reason: `${DATABASE_FILE} is not a Wololo database` };
    const row = sqlite.query('SELECT MAX(created_at) AS latest FROM __drizzle_migrations').get() as {
      latest: number | null;
    } | null;
    if ((row?.latest ?? 0) > latestMigrationMillis)
      return { ok: false, reason: 'the backup comes from a newer Wololo version; update Wololo first' };
    return { ok: true };
  } catch {
    return { ok: false, reason: `${DATABASE_FILE} is not a readable SQLite database` };
  } finally {
    sqlite?.close();
  }
}

/** Checks extracted backup files before they are staged: a sound Wololo database not newer than this build. */
export function validateRestoreFiles(dir: string, latestMigrationMillis: number): RestoreValidation {
  const config = validateConfig(join(dir, CONFIG_FILE));
  if (!config.ok) return config;
  return validateDatabase(join(dir, DATABASE_FILE), latestMigrationMillis);
}

/**
 * Backups carry data, not filesystem pointers: job log and temp paths are dropped (both are derived again at runtime),
 * and recycle-bin entries that do not point into a recycle stamp folder are marked purged without touching any file.
 */
export function scrubRestoredDatabase(path: string, now: Date): RestoreValidation {
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(path, { strict: true });
    const db = sqlite;
    db.run('PRAGMA journal_mode = DELETE');
    const active = db.query<{ id: number; recyclePath: string; originalPath: string }, []>(
      'SELECT id, recycle_path AS recyclePath, original_path AS originalPath FROM recycle_bin WHERE restored_at IS NULL AND purged_at IS NULL',
    );
    const purge = db.query('UPDATE recycle_bin SET purged_at = $purgedAt WHERE id = $id');
    db.transaction(() => {
      db.run('UPDATE jobs SET log_path = NULL, temp_path = NULL');
      for (const row of active.all()) {
        if (isRecyclePath(row.recyclePath) && isNormalizedAbsolutePath(row.originalPath)) continue;
        purge.run({ purgedAt: now.toISOString(), id: row.id });
      }
    })();
    return { ok: true };
  } catch {
    return { ok: false, reason: `${DATABASE_FILE} is missing Wololo tables` };
  } finally {
    sqlite?.close();
  }
}
