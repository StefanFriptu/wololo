import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type Runtime } from '../../src/app/bootstrap.ts';
import type { BackupInfo, GeneralConfigView, RestoreResult, SystemStatus } from '../../src/shared/api-types.ts';
import type { Settings } from '../../src/shared/settings.ts';

interface Booted {
  runtime: Runtime;
  base: string;
  apiKey: string;
}

let configDir: string;
let current: Booted | null = null;

async function boot(): Promise<Booted> {
  const runtime = createRuntime({
    env: { WOLOLO_WEB_DIR: join(configDir, 'no-web') },
    configDir,
    port: 0,
    console: false,
  });
  const server = await runtime.start();
  current = { runtime, base: `http://127.0.0.1:${server.port}`, apiKey: runtime.ctx.config.get().apiKey };
  return current;
}

async function shutdown(): Promise<void> {
  await current?.runtime.stop('test');
  current = null;
}

async function call<T>(booted: Booted, path: string, init: RequestInit = {}, status = 200): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-api-key', booted.apiKey);
  const response = await fetch(`${booted.base}${path}`, { ...init, headers });
  if (response.status !== status)
    throw new Error(`${path}: expected ${status}, got ${response.status}: ${await response.text()}`);
  return (status === 204 ? undefined : await response.json()) as T;
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wololo-integration-'));
});

afterAll(async () => {
  await shutdown();
  rmSync(configDir, { recursive: true, force: true });
});

describe('booted server', () => {
  test('step 1 - first start writes config.json, answers /health without a key and guards the API', async () => {
    const booted = await boot();
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toMatchObject({ apiKey: booted.apiKey });
    const health = await fetch(`${booted.base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${booted.base}/api/v1/system/status`)).status).toBe(401);
    const status = await call<SystemStatus>(booted, '/api/v1/system/status');
    expect(status).toMatchObject({ appName: 'Wololo', configDir });
    expect(status.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test('step 2 - API documentation is served: public HTML page and keyed JSON', async () => {
    const booted = current as Booted;
    const docs = await fetch(`${booted.base}/api/v1/docs`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('Wololo API');
    const document = await call<{ openapi: string; paths: Record<string, unknown> }>(booted, '/api/v1/openapi.json');
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/api/v1/system/backups/{name}/restore');
  });

  test('step 3 - a backup taken now is restored across a restart, API key included', async () => {
    const booted = current as Booted;
    const originalKey = booted.apiKey;
    await call<Settings>(booted, '/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ processing: { concurrency: 2 } }),
    });
    const backup = await call<BackupInfo>(booted, '/api/v1/system/backups', { method: 'POST' });

    await call<Settings>(booted, '/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ processing: { concurrency: 4 } }),
    });
    const regenerated = await call<GeneralConfigView>(booted, '/api/v1/settings/general/apikey', { method: 'POST' });
    expect(regenerated.apiKey).not.toBe(originalKey);
    booted.apiKey = regenerated.apiKey;

    const restore = await call<RestoreResult>(booted, `/api/v1/system/backups/${backup.name}/restore`, {
      method: 'POST',
    });
    expect(restore).toEqual({ restartRequired: true });
    await shutdown();

    const restarted = await boot();
    expect(restarted.apiKey).toBe(originalKey);
    expect(existsSync(join(configDir, 'restore'))).toBe(false);
    const settings = await call<Settings>(restarted, '/api/v1/settings');
    expect(settings.processing.concurrency).toBe(2);
    const kinds = (await call<BackupInfo[]>(restarted, '/api/v1/system/backups')).map((entry) => entry.kind).sort();
    expect(kinds).toEqual(['manual', 'pre_restore']);
  });

  test('step 4 - graceful stop flushes the log file', async () => {
    const booted = current as Booted;
    await call<unknown>(booted, '/api/v1/system/health');
    await shutdown();
    const log = readFileSync(join(configDir, 'logs', 'wololo.txt'), 'utf8');
    expect(log).toContain('applied a staged backup restore');
    expect(log).toContain('shutting down');
  });
});
