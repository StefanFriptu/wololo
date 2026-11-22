import { constants, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { release, type } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { SystemService } from '../../contracts/platform.ts';
import { freeBytes } from '../../core/freeBytes.ts';
import { findExecutable, runProcess } from '../../core/process.ts';
import { MIGRATIONS_DIR } from '../../db/client.ts';
import type { SystemStatus } from '../../shared/api-types.ts';
import { createBackupStore } from './backups.ts';
import { existingJobIdsQuery } from './existingJobIdsQuery.ts';
import { buildHealthChecks, type LibraryRootFact } from './healthChecks.ts';
import { enabledLibraryRootsQuery, libraryCountQuery } from './libraryRootsQuery.ts';
import { platformOpenApi } from './platformOpenApi.ts';
import { RESTORE_DIR } from './restore.ts';
import { ROOT_PROBE_TIMEOUT_MS, rootProblem } from './rootProblem.ts';
import { JOB_LOG_MAX_AGE_DAYS, jobIdOfLog, selectStaleJobLogs } from './staleJobLogs.ts';
import { probeTools, type ToolReport } from './tools.ts';
import { withTimeout } from './withTimeout.ts';

const TOOL_CACHE_MS = 5 * 60 * 1000;
export const RESTART_DELAY_MS = 250;

function latestMigrationMillis(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number }[];
  };
  return Math.max(0, ...journal.entries.map((entry) => entry.when));
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isWritable(path: string): Promise<boolean> {
  const check = access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
  return withTimeout(check, ROOT_PROBE_TIMEOUT_MS, false);
}

function freeBytesWithTimeout(path: string): Promise<number | null> {
  const check = freeBytes(path).catch(() => null);
  return withTimeout(check, ROOT_PROBE_TIMEOUT_MS, null);
}

export function createSystemService(ctx: AppContext): SystemService {
  const log = ctx.logs.logger('system');
  const config = () => ctx.config.get();
  const backups = createBackupStore({
    backupDir: config().backupDir,
    configDir: config().configDir,
    configFile: config().configFile,
    sqlite: ctx.dbHandle.sqlite,
    log,
    now: () => new Date(),
    latestMigrationMillis,
  });

  let toolCache: { at: number; report: Promise<ToolReport> } | null = null;
  const toolReport = (): Promise<ToolReport> => {
    if (toolCache && Date.now() - toolCache.at < TOOL_CACHE_MS) return toolCache.report;
    const report = probeTools(config().tools, {
      which: findExecutable,
      run: runProcess,
      signal: ctx.shutdownSignal,
      log,
    });
    toolCache = { at: Date.now(), report };
    return report;
  };

  const status = async (): Promise<SystemStatus> => {
    const current = config();
    const { tools } = await toolReport();
    return {
      appName: 'Wololo',
      version: current.version,
      instanceName: current.instanceName,
      startTime: ctx.startedAt.toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000)),
      runtime: `Bun ${Bun.version}`,
      os: `${type()} ${release()}`,
      arch: process.arch,
      isDocker: current.isDocker,
      configDir: current.configDir,
      databasePath: current.databasePath,
      databaseSizeBytes: ['', '-wal', '-shm'].reduce(
        (sum, suffix) => sum + fileSize(`${current.databasePath}${suffix}`),
        0,
      ),
      memoryRssBytes: process.memoryUsage().rss,
      urlBase: current.urlBase,
      tools,
    };
  };

  const health = async () => {
    const current = config();
    const [roots, configWritable, configFreeBytes, tools] = await Promise.all([
      Promise.all(
        enabledLibraryRootsQuery(ctx.db)
          .all()
          .map(async (root): Promise<LibraryRootFact> => ({ ...root, problem: await rootProblem(root.path) })),
      ),
      isWritable(current.configDir),
      freeBytesWithTimeout(current.configDir),
      toolReport(),
    ]);
    return buildHealthChecks({
      platform: process.platform,
      isDocker: current.isDocker,
      uid: process.getuid?.() ?? null,
      tools,
      libraryCount: libraryCountQuery(ctx.db).get()?.total ?? 0,
      roots,
      configDir: current.configDir,
      configWritable,
      configFreeBytes,
      processingEnabled: ctx.settings.section('processing').enabled,
      restorePending: existsSync(join(current.configDir, RESTORE_DIR)),
    });
  };

  const cleanupLogs = async (): Promise<string> => {
    const dir = config().jobLogDir;
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => jobIdOfLog(name) !== null)
          .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
      : [];
    const ids = files.map((file) => jobIdOfLog(file.name) as number);
    const stale = selectStaleJobLogs({
      files,
      existingJobIds: new Set(existingJobIdsQuery(ctx.db, ids).flatMap((query) => query.all().map((row) => row.id))),
      nowMs: Date.now(),
    });
    for (const name of stale) rmSync(join(dir, name), { force: true });
    const message = `Removed ${stale.length} job ${stale.length === 1 ? 'log' : 'logs'} older than ${JOB_LOG_MAX_AGE_DAYS} days`;
    log.info(message);
    return message;
  };

  return {
    status,
    health,
    tools: async () => (await toolReport()).tools,
    listBackups: async () => backups.list(),
    createBackup: (kind) => backups.create(kind),
    backupPath: async (name) => backups.path(name),
    deleteBackup: async (name) => backups.remove(name),
    restoreBackup: (name) => backups.restore(name),
    restoreUpload: (bytes) => backups.restoreBytes(bytes),
    cleanupLogs,
    openApiDocument: () => {
      const { document, warnings } = platformOpenApi(config());
      for (const warning of warnings) log.warn('OpenAPI: request schema could not be converted', { warning });
      return document;
    },
    restart: async () => {
      log.info('restart requested');
      setTimeout(() => ctx.requestRestart(), RESTART_DELAY_MS);
    },
  };
}
