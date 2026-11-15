import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/api/http.ts';
import {
  type AppContext,
  createAppContext,
  type Services,
} from '../../src/app/context.ts';
import { createHttpApp } from '../../src/app/server.ts';
import { ConfigStore } from '../../src/core/config.ts';
import { LogHub } from '../../src/core/logger.ts';
import { openDatabase, runMigrations } from '../../src/db/client.ts';
import type { DeepPartial, Settings } from '../../src/shared/settings.ts';

export const TEST_API_KEY = 'test-api-key-0123456789abcdef';

export interface TestContext {
  ctx: AppContext;
  app: Hono<AppEnv>;
  /** Temp directory holding config.json, wololo.db and logs; also a handy scratch space. */
  dir: string;
  /** app.request with the API key header set. */
  request(path: string, init?: RequestInit): Promise<Response>;
  cleanup(): void;
}

export interface TestContextOptions {
  settings?: DeepPartial<Settings>;
  overrides?: Partial<Services>;
  env?: Record<string, string>;
}

/** Fresh temp config dir + migrated SQLite db + full AppContext (real core, module services as currently implemented). */
export function createTestContext(
  options: TestContextOptions = {},
): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-test-'));
  const config = new ConfigStore({
    configDir: dir,
    env: {
      WOLOLO__API_KEY: TEST_API_KEY,
      WOLOLO_WEB_DIR: join(dir, 'web'),
      ...options.env,
    },
  });
  const logs = new LogHub({ level: 'debug', logDir: null, console: false });
  const dbHandle = openDatabase(join(dir, 'wololo.db'));
  runMigrations(dbHandle);
  const ctx = createAppContext({
    config,
    logs,
    dbHandle,
    overrides: options.overrides,
  });
  if (options.settings) ctx.settings.update(options.settings);
  const app = createHttpApp(ctx);

  return {
    ctx,
    app,
    dir,
    request: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has('x-api-key')) headers.set('x-api-key', TEST_API_KEY);
      return Promise.resolve(app.request(path, { ...init, headers }));
    },
    cleanup: () => {
      ctx.requestShutdown();
      logs.close();
      dbHandle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
