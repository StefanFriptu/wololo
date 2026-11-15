import type { Server } from 'bun';
import type { Hono } from 'hono';
import type { AppEnv } from '../api/http.ts';
import { ConfigStore, resolveConfigDir } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import { LogHub } from '../core/logger.ts';
import { openDatabase, runMigrations } from '../db/client.ts';
import { applyPendingRestore } from '../modules/system/restore.ts';
import { type AppContext, createAppContext, type Services } from './context.ts';
import { createHttpApp } from './server.ts';

export interface RuntimeOptions {
  env: Record<string, string | undefined>;
  configDir?: string;
  /** Overrides the configured port (0 = ephemeral, for integration tests); the returned Server reports the real port. */
  port?: number;
  console?: boolean;
  overrides?: Partial<Services>;
}

export interface Runtime {
  ctx: AppContext;
  app: Hono<AppEnv>;
  /** Starts services (profile seed, crash recovery, scheduler with its task rows, worker) and the HTTP server. */
  start(): Promise<Server<undefined>>;
  stop(reason: string): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

export function createRuntime(options: RuntimeOptions): Runtime {
  const configDir = options.configDir ?? resolveConfigDir(options.env, process.cwd());
  const restored = applyPendingRestore(configDir);
  const config = new ConfigStore({ env: options.env, configDir });
  const logs = new LogHub({
    level: config.get().logLevel,
    logDir: config.get().logDir,
    console: options.console ?? true,
  });
  const log = logs.logger('bootstrap');
  if (restored) log.warn('applied a staged backup restore');
  for (const warning of config.get().warnings) log.warn(warning);

  const dbHandle = openDatabase(config.get().databasePath);
  const migration = runMigrations(dbHandle, { backupDir: config.get().backupDir });
  if (migration.backupPath) log.info('database backed up before migrating', { path: migration.backupPath });
  let stopRuntime: (reason: string) => Promise<void> = async () => {};
  const ctx = createAppContext({
    config,
    logs,
    dbHandle,
    overrides: options.overrides,
    requestRestart: () => {
      void stopRuntime('restart').finally(() => process.exit(0));
    },
  });
  const app = createHttpApp(ctx);
  let server: Server<undefined> | null = null;
  let stopping: Promise<void> | null = null;

  const start = async () => {
    const { services } = ctx;
    await services.profiles.ensureDefaults();
    const recovery = await services.jobs.recover();
    if (recovery.requeued || recovery.completed || recovery.tempFilesDeleted) log.info('crash recovery', recovery);
    await services.scheduler.start();
    await services.jobs.start();

    const current = ctx.config.get();
    server = Bun.serve({
      port: options.port ?? current.port,
      hostname: current.bindAddress === '*' ? '0.0.0.0' : current.bindAddress,
      fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
      idleTimeout: 120,
    });
    log.info(`Wololo ${current.version} listening on http://${server.hostname}:${server.port}${current.urlBase}/`);
    return server;
  };

  const stop = (reason: string) => {
    stopping ??= (async () => {
      log.info('shutting down', { reason });
      ctx.requestShutdown();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.());
      const steps = (async () => {
        for (const [name, step] of [
          ['scheduler', () => ctx.services.scheduler.stop()],
          ['jobs', () => ctx.services.jobs.stop()],
          ['http', async () => server?.stop(true)],
        ] as const) {
          try {
            await step();
          } catch (error) {
            log.error(`shutdown step ${name} failed`, {
              error: errorMessage(error),
            });
          }
        }
      })();
      await Promise.race([steps, timeout]);
      logs.close();
      dbHandle.close();
    })();
    return stopping;
  };

  stopRuntime = stop;
  return { ctx, app, start, stop };
}
