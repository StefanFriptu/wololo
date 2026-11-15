import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema.ts';

export type Db = BunSQLiteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database;
  close(): void;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDatabase(path: string): DbHandle {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA synchronous = NORMAL');
  sqlite.run('PRAGMA foreign_keys = ON');
  sqlite.run('PRAGMA busy_timeout = 5000');
  sqlite.run('PRAGMA cache_size = -4000');
  const db = drizzle({ client: sqlite, schema });
  return {
    db,
    sqlite,
    close: () => {
      try {
        sqlite.run('PRAGMA optimize');
      } finally {
        sqlite.close();
      }
    },
  };
}

export interface MigrateOptions {
  migrationsFolder?: string;
  /** When set and an existing database has pending migrations, it is first copied to <backupDir>/pre-migration-<ts>.db. */
  backupDir?: string;
}

export interface MigrateResult {
  pending: boolean;
  backupPath: string | null;
}

function latestJournalMillis(migrationsFolder: string): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number }[];
  };
  return Math.max(0, ...journal.entries.map((entry) => entry.when));
}

function latestAppliedMillis(sqlite: Database): number | null {
  const table = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!table) return null;
  const row = sqlite.query('SELECT MAX(created_at) AS latest FROM __drizzle_migrations').get() as {
    latest: number | null;
  } | null;
  return row?.latest ?? null;
}

/**
 * Applies pending drizzle-kit migrations. Foreign keys are switched off around the migration (SQLite ignores
 * `PRAGMA foreign_keys` inside drizzle's transaction, so table-rebuild migrations would otherwise cascade-delete child
 * rows) and the result is checked with `PRAGMA foreign_key_check` before they are switched back on.
 */
export function runMigrations(handle: DbHandle, options: MigrateOptions = {}): MigrateResult {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_DIR;
  const applied = latestAppliedMillis(handle.sqlite);
  const pending = applied === null || applied < latestJournalMillis(migrationsFolder);
  let backupPath: string | null = null;
  if (pending && applied !== null && options.backupDir) {
    mkdirSync(options.backupDir, { recursive: true });
    backupPath = join(options.backupDir, `pre-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    handle.sqlite.run('VACUUM INTO ?', [backupPath]);
  }
  handle.sqlite.run('PRAGMA foreign_keys = OFF');
  try {
    migrate(handle.db, { migrationsFolder });
    const violations = handle.sqlite.query('PRAGMA foreign_key_check').all();
    if (violations.length > 0)
      throw new Error(
        `migration left ${violations.length} foreign key violations: ${JSON.stringify(violations.slice(0, 5))}`,
      );
  } finally {
    handle.sqlite.run('PRAGMA foreign_keys = ON');
  }
  return { pending, backupPath };
}

export { schema };
