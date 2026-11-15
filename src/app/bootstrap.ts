import type { Server } from 'bun';
import type { Hono } from 'hono';
import type { AppEnv } from '../api/http.ts';
import { ConfigStore } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import { LogHub } from '../core/logger.ts';
import { openDatabase, runMigrations } from '../db/client.ts';
import { applyPendingRestore } from '../modules/system/restore.ts';
import { type AppContext, createAppContext, type Services } from './context.ts';
import { createHttpApp } from './server.ts';

export interface RuntimeOptions {
  env: Record<string, string | undefined>;
  configDir?: string;
  console?: boolean;
  overrides?: Partial<Services>;
}

export interface Runtime {
  ctx: AppContext;
  app: Hono<AppEnv>;
  /** Starts services (profiles seed, crash recovery, worker, scheduler) and the HTTP server. */
  start(): Promise<Server<undefined>>;
  stop(reason: string): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

export function createRuntime(options: RuntimeOptions): Runtime {
  const config = new ConfigStore({
    env: options.env,
    configDir: options.configDir,
  });
  const logs = new LogHub({
    level: config.get().logLevel,
    logDir: config.get().logDir,
    console: options.console ?? true,
  });
  const log = logs.logger('bootstrap');

  const restored = applyPendingRestore(config.get());
  if (restored) log.warn('applied a staged backup restore');

  const dbHandle = openDatabase(config.get().databasePath);
  runMigrations(dbHandle);
  const ctx = createAppContext({
    config,
    logs,
    dbHandle,
    overrides: options.overrides,
  });
  const app = createHttpApp(ctx);
  let server: Server<undefined> | null = null;
  let stopping: Promise<void> | null = null;

  const start = async () => {
    const { services } = ctx;
    await services.profiles.ensureDefaults();
    const recovery = await services.jobs.recover();
    if (recovery.requeued || recovery.tempFilesDeleted)
      log.info('crash recovery', recovery);
    await services.jobs.start();
    await services.scheduler.start();

    const current = ctx.config.get();
    server = Bun.serve({
      port: current.port,
      hostname: current.bindAddress === '*' ? '0.0.0.0' : current.bindAddress,
      fetch: app.fetch,
      idleTimeout: 120,
    });
    log.info(
      `Wololo ${current.version} listening on http://${server.hostname}:${server.port}${current.urlBase}/`,
    );
    return server;
  };

  const stop = (reason: string) => {
    stopping ??= (async () => {
      log.info('shutting down', { reason });
      ctx.requestShutdown();
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.(),
      );
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

  return { ctx, app, start, stop };
}
