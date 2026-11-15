import { afterAll, describe, expect, test } from 'bun:test';
import { createTestContext } from '../helpers/context.ts';

const t = createTestContext();
afterAll(() => t.cleanup());

describe('migrations', () => {
  test('create every v1 table', () => {
    const tables = t.ctx.dbHandle.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      'arr_instances',
      'bdmv_decisions',
      'device_profiles',
      'download_client',
      'job_history',
      'jobs',
      'libraries',
      'library_profiles',
      'library_roots',
      'media_files',
      'path_mappings',
      'plex_connection',
      'recycle_bin',
      'scheduled_tasks',
      'settings',
    ]);
  });

  test('enable foreign keys and WAL', () => {
    const sqlite = t.ctx.dbHandle.sqlite;
    expect(sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  });
});
