import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '../../src/db/client.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INIT = `CREATE TABLE \`parent\` (\`id\` integer PRIMARY KEY NOT NULL, \`name\` text);
--> statement-breakpoint
CREATE TABLE \`child\` (\`id\` integer PRIMARY KEY NOT NULL, \`parent_id\` integer NOT NULL REFERENCES \`parent\`(\`id\`) ON DELETE cascade);`;

const REBUILD = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_parent\` (\`id\` integer PRIMARY KEY NOT NULL, \`name\` text NOT NULL DEFAULT '');
--> statement-breakpoint
INSERT INTO \`__new_parent\`("id", "name") SELECT "id", coalesce("name", '') FROM \`parent\`;--> statement-breakpoint
DROP TABLE \`parent\`;--> statement-breakpoint
ALTER TABLE \`__new_parent\` RENAME TO \`parent\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

function migrationsFolder(migrations: { tag: string; sql: string; when: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-migrations-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  for (const migration of migrations) writeFileSync(join(dir, `${migration.tag}.sql`), migration.sql);
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: migrations.map((migration, idx) => ({
        idx,
        version: '6',
        when: migration.when,
        tag: migration.tag,
        breakpoints: true,
      })),
    }),
  );
  return dir;
}

test('a drizzle-kit table rebuild keeps child rows, backs up first and re-enables foreign keys', () => {
  const work = mkdtempSync(join(tmpdir(), 'wololo-db-'));
  dirs.push(work);
  const handle = openDatabase(join(work, 'wololo.db'));
  try {
    const first = runMigrations(handle, {
      migrationsFolder: migrationsFolder([{ tag: '0000_init', sql: INIT, when: 1 }]),
      backupDir: join(work, 'backups'),
    });
    expect(first).toEqual({ pending: true, backupPath: null });
    handle.sqlite.run("INSERT INTO parent (id, name) VALUES (1, 'p')");
    for (const id of [1, 2, 3]) handle.sqlite.run('INSERT INTO child (id, parent_id) VALUES (?, 1)', [id]);

    const second = runMigrations(handle, {
      migrationsFolder: migrationsFolder([
        { tag: '0000_init', sql: INIT, when: 1 },
        { tag: '0001_rebuild', sql: REBUILD, when: 2 },
      ]),
      backupDir: join(work, 'backups'),
    });

    expect(handle.sqlite.query('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 3 });
    expect(handle.sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(second.pending).toBe(true);
    expect(second.backupPath && existsSync(second.backupPath)).toBe(true);
    expect(readdirSync(join(work, 'backups'))).toHaveLength(1);
  } finally {
    handle.close();
  }
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

test('openDatabase - a new database and its WAL files are readable by the owner only', () => {
  const work = mkdtempSync(join(tmpdir(), 'wololo-db-'));
  dirs.push(work);
  const path = join(work, 'wololo.db');
  const previous = process.umask(0o002);
  try {
    const handle = openDatabase(path);
    handle.sqlite.run('CREATE TABLE t (id INTEGER)');
    expect([modeOf(path), modeOf(`${path}-wal`), modeOf(`${path}-shm`)]).toEqual([0o600, 0o600, 0o600]);
    handle.close();
  } finally {
    process.umask(previous);
  }
});

test('openDatabase - tightens an existing world-readable database and its WAL files', () => {
  const work = mkdtempSync(join(tmpdir(), 'wololo-db-'));
  dirs.push(work);
  const path = join(work, 'wololo.db');
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    writeFileSync(file, '');
    chmodSync(file, 0o644);
  }
  const handle = openDatabase(path);
  expect([modeOf(path), modeOf(`${path}-wal`), modeOf(`${path}-shm`)]).toEqual([0o600, 0o600, 0o600]);
  handle.close();
});

test('runMigrations - the pre-migration copy and its folder are private', () => {
  const work = mkdtempSync(join(tmpdir(), 'wololo-db-'));
  dirs.push(work);
  const handle = openDatabase(join(work, 'wololo.db'));
  const backupDir = join(work, 'backups');
  try {
    runMigrations(handle, { migrationsFolder: migrationsFolder([{ tag: '0000_init', sql: INIT, when: 1 }]) });
    const result = runMigrations(handle, {
      migrationsFolder: migrationsFolder([
        { tag: '0000_init', sql: INIT, when: 1 },
        { tag: '0001_rebuild', sql: REBUILD, when: 2 },
      ]),
      backupDir,
    });
    expect(result.backupPath).not.toBeNull();
    expect(modeOf(result.backupPath as string)).toBe(0o600);
    expect(modeOf(backupDir)).toBe(0o700);
  } finally {
    handle.close();
  }
});

const OLD_COPIES = [1, 2, 3, 4].map((day) => `pre-migration-2020-01-0${day}T00-00-00-000Z.db`);

function upgradeWithOldCopies(second: string): { backupDir: string; run: () => void } {
  const work = mkdtempSync(join(tmpdir(), 'wololo-db-'));
  dirs.push(work);
  const handle = openDatabase(join(work, 'wololo.db'));
  const backupDir = join(work, 'backups');
  runMigrations(handle, { migrationsFolder: migrationsFolder([{ tag: '0000_init', sql: INIT, when: 1 }]) });
  mkdirSync(backupDir);
  for (const name of [...OLD_COPIES, 'notes.txt']) writeFileSync(join(backupDir, name), '');
  const folder = migrationsFolder([
    { tag: '0000_init', sql: INIT, when: 1 },
    { tag: '0001_next', sql: second, when: 2 },
  ]);
  return {
    backupDir,
    run: () => {
      try {
        runMigrations(handle, { migrationsFolder: folder, backupDir });
      } finally {
        handle.close();
      }
    },
  };
}

test('runMigrations - keeps only the newest two pre-migration copies after a successful upgrade', () => {
  const { backupDir, run } = upgradeWithOldCopies(REBUILD);
  expect(readdirSync(backupDir)).toHaveLength(5);

  run();

  const left = readdirSync(backupDir).sort();
  expect(left).toHaveLength(3);
  expect(left).toContain('notes.txt');
  expect(left).toContain(OLD_COPIES[3]);
  expect(left.filter((name) => name.startsWith('pre-migration-2020'))).toEqual([OLD_COPIES[3]]);
});

test('runMigrations - a failed upgrade deletes no pre-migration copy', () => {
  const { backupDir, run } = upgradeWithOldCopies('THIS IS NOT SQL;');

  expect(run).toThrow();

  const left = readdirSync(backupDir);
  expect(left).toHaveLength(6);
  for (const name of OLD_COPIES) expect(left).toContain(name);
});
