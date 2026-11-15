import { Database } from 'bun:sqlite';
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

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

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

export function runMigrations(
  handle: DbHandle,
  migrationsFolder = MIGRATIONS_DIR,
): void {
  migrate(handle.db, { migrationsFolder });
}

export { schema };
