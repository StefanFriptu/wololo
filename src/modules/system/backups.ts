import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { BackupInfo, RestoreResult } from '../../shared/api-types.ts';
import { extractZipEntries, writeZipArchive } from './backupArchive.ts';
import { type BackupKind, formatBackupName, parseBackupKind, selectBackupsToPrune } from './backupNames.ts';
import { CONFIG_FILE, DATABASE_FILE, RESTORE_DIR, RESTORE_STAGING_PREFIX, validateRestoreFiles } from './restore.ts';

export interface BackupStoreDeps {
  backupDir: string;
  configDir: string;
  configFile: string;
  sqlite: Database;
  log: Logger;
  now: () => Date;
  /** created_at of the newest migration this build ships; newer backups are refused. */
  latestMigrationMillis: () => number;
}

export interface BackupStore {
  list(): BackupInfo[];
  create(kind: BackupKind): Promise<BackupInfo>;
  path(name: string): string;
  remove(name: string): void;
  restore(name: string): Promise<RestoreResult>;
  restoreBytes(bytes: Uint8Array): Promise<RestoreResult>;
}

const EXTRACT_LIMITS: Readonly<Record<string, number>> = {
  [DATABASE_FILE]: 16 * 1024 ** 3,
  [CONFIG_FILE]: 1024 * 1024,
};

const INTERRUPTED_TEMP_FILE = /^\.wololo_backup_.+\.(db|partial)$/;

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Backups under <config>/backups: zip of a VACUUM INTO snapshot plus config.json; restores are staged for next start. */
export function createBackupStore(deps: BackupStoreDeps): BackupStore {
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const info = (name: string, kind: BackupKind): BackupInfo => {
    const stat = statSync(join(deps.backupDir, name));
    return { name, kind, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
  };

  const list = (): BackupInfo[] => {
    if (!existsSync(deps.backupDir)) return [];
    return readdirSync(deps.backupDir, { withFileTypes: true })
      .flatMap((entry) => {
        const kind = parseBackupKind(entry.name);
        return kind && entry.isFile() ? [info(entry.name, kind)] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  };

  const path = (name: string): string => {
    if (basename(name) !== name || parseBackupKind(name) === null) throw notFound('backup');
    const file = join(deps.backupDir, name);
    if (!existsSync(file)) throw notFound('backup');
    return file;
  };

  const prune = () => {
    for (const name of selectBackupsToPrune(list())) {
      rmSync(join(deps.backupDir, name), { force: true });
      deps.log.info('old backup removed', { name });
    }
  };

  const removeInterruptedTempFiles = () => {
    for (const name of readdirSync(deps.backupDir).filter((entry) => INTERRUPTED_TEMP_FILE.test(entry))) {
      rmSync(join(deps.backupDir, name), { force: true });
      deps.log.warn('removed a temp file left by an interrupted backup', { name });
    }
  };

  const createUnlocked = async (kind: BackupKind): Promise<BackupInfo> => {
    mkdirSync(deps.backupDir, { recursive: true });
    removeInterruptedTempFiles();
    const date = deps.now();
    let clash = 0;
    while (existsSync(join(deps.backupDir, formatBackupName(kind, date, clash)))) clash += 1;
    const name = formatBackupName(kind, date, clash);
    const snapshot = join(deps.backupDir, `.${name}.db`);
    const partial = join(deps.backupDir, `.${name}.partial`);
    try {
      deps.sqlite.run('VACUUM INTO ?', [snapshot]);
      const entries = [{ name: DATABASE_FILE, sourcePath: snapshot }];
      if (existsSync(deps.configFile)) entries.push({ name: CONFIG_FILE, sourcePath: deps.configFile });
      await writeZipArchive(partial, entries);
      renameSync(partial, join(deps.backupDir, name));
    } finally {
      rmSync(snapshot, { force: true });
      rmSync(partial, { force: true });
    }
    const created = info(name, kind);
    deps.log.info('backup created', { name, kind, sizeBytes: created.sizeBytes });
    prune();
    return created;
  };

  const stageRestore = async (chunks: AsyncIterable<Uint8Array>, source: string): Promise<RestoreResult> => {
    const staging = join(deps.configDir, `${RESTORE_STAGING_PREFIX}${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    try {
      try {
        await extractZipEntries(chunks, staging, EXTRACT_LIMITS);
      } catch (error) {
        throw new AppError('unprocessable', `${source} is not a readable backup archive: ${errorMessage(error)}`);
      }
      const validation = validateRestoreFiles(staging, deps.latestMigrationMillis());
      if (!validation.ok) throw new AppError('unprocessable', `cannot restore ${source}: ${validation.reason}`);
      await createUnlocked('pre_restore');
      const target = join(deps.configDir, RESTORE_DIR);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      deps.log.warn('backup restore staged; it is applied on the next start', { source });
      return { restartRequired: true };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };

  return {
    list,
    path,
    create: (kind) => exclusive(() => createUnlocked(kind)),
    remove: (name) => {
      rmSync(path(name), { force: true });
      deps.log.info('backup deleted', { name });
    },
    restore: (name) => exclusive(() => stageRestore(Bun.file(path(name)).stream(), name)),
    restoreBytes: (bytes) => exclusive(() => stageRestore(single(bytes), 'the uploaded file')),
  };
}
