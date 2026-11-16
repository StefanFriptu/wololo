import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary } from '../../../test/helpers/seed.ts';
import { routesOf, splitRouteKey } from '../../shared/api-routes.ts';
import type { BackupInfo, HealthCheck, RestoreResult, SystemStatus } from '../../shared/api-types.ts';
import { RESTART_DELAY_MS } from './index.ts';
import { RESTORE_DIR } from './restore.ts';

let t: TestContext;

beforeAll(() => {
  t = createTestContext();
});

afterAll(() => t.cleanup());

afterEach(() => {
  for (const name of readdirSync(t.ctx.config.get().backupDir)) rmSync(join(t.ctx.config.get().backupDir, name));
  rmSync(join(t.dir, RESTORE_DIR), { recursive: true, force: true });
});

async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status)
    throw new Error(`expected ${status}, got ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function createBackup(): Promise<BackupInfo> {
  return json<BackupInfo>(await t.request('/api/v1/system/backups', { method: 'POST' }));
}

function upload(bytes: Uint8Array | string, field = 'file'): Promise<Response> {
  const form = new FormData();
  form.append(field, new File([bytes], 'backup.zip', { type: 'application/zip' }));
  return t.request('/api/v1/system/backups/restore', { method: 'POST', body: form });
}

async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  let attempts = 0;
  while (!check()) {
    attempts += 1;
    if (Date.now() - started > timeoutMs) throw new Error(`condition not met after ${attempts} attempts`);
    await Bun.sleep(20);
  }
}

test('platform routes - every parameterless GET answers 200', async () => {
  const safe = routesOf('platform').filter((key) => splitRouteKey(key).method === 'GET' && !key.includes(':'));
  expect(safe.length).toBeGreaterThan(3);
  for (const key of safe) {
    const response = await t.request(splitRouteKey(key).path);
    expect({ key, status: response.status }).toEqual({ key, status: 200 });
  }
});

test('GET /api/v1/system/status - reports version, paths, runtime and the six tools', async () => {
  const status = await json<SystemStatus>(await t.request('/api/v1/system/status'));
  expect(status).toMatchObject({
    appName: 'Wololo',
    version: t.ctx.config.get().version,
    configDir: t.dir,
    databasePath: join(t.dir, 'wololo.db'),
    urlBase: '',
    arch: process.arch,
  });
  expect(status.runtime).toStartWith('Bun ');
  expect(status.databaseSizeBytes).toBeGreaterThan(0);
  expect(status.memoryRssBytes).toBeGreaterThan(0);
  expect(status.tools.map((tool) => tool.name).sort()).toEqual([
    '7z',
    'ffmpeg',
    'ffprobe',
    'ionice',
    'mkvmerge',
    'nice',
  ]);
});

test('GET /api/v1/system/health - flags unreachable library roots and dry-run mode', async () => {
  insertLibrary(t.ctx.db, { name: 'Ghost movies', roots: [join(t.dir, 'does-not-exist')] });
  const checks = await json<HealthCheck[]>(await t.request('/api/v1/system/health'));
  expect(checks).toContainEqual({
    source: 'libraries',
    level: 'error',
    message: expect.stringContaining(`Library "Ghost movies": root folder ${join(t.dir, 'does-not-exist')}`),
  });
  expect(checks.some((check) => check.source === 'processing')).toBe(true);
});

test('backups - create, list, download as zip, delete', async () => {
  expect(await json<BackupInfo[]>(await t.request('/api/v1/system/backups'))).toEqual([]);
  const created = await createBackup();
  expect(created.kind).toBe('manual');
  expect(created.name).toMatch(/^wololo_backup_manual_.*\.zip$/);
  expect(await json<BackupInfo[]>(await t.request('/api/v1/system/backups'))).toEqual([created]);

  const download = await t.request(`/api/v1/system/backups/${created.name}`);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('application/zip');
  expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${created.name}"`);
  const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
  expect(Object.keys(files).sort()).toEqual(['config.json', 'wololo.db']);
  expect(JSON.parse(new TextDecoder().decode(files['config.json']))).toMatchObject({ port: 8585 });

  expect((await t.request(`/api/v1/system/backups/${created.name}`, { method: 'DELETE' })).status).toBe(204);
  expect(await json<BackupInfo[]>(await t.request('/api/v1/system/backups'))).toEqual([]);
});

test('backups - the backup folder is private to the owner', async () => {
  await createBackup();
  expect(statSync(t.ctx.config.get().backupDir).mode & 0o777).toBe(0o700);
});

test.each([
  ['GET', 'wololo_backup_manual_2020.01.01_00.00.00.zip'],
  ['DELETE', 'wololo_backup_manual_2020.01.01_00.00.00.zip'],
  ['GET', '..%2Fconfig.json'],
  ['GET', 'config.json'],
  ['POST', 'wololo.db'],
])('backups - %s of %p is a 404', async (method, name) => {
  const suffix = method === 'POST' ? '/restore' : '';
  const response = await t.request(`/api/v1/system/backups/${name}${suffix}`, { method });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: 'not_found' });
});

test('backups - restoring a stored backup stages it and keeps a pre_restore backup', async () => {
  const created = await createBackup();
  const result = await json<RestoreResult>(
    await t.request(`/api/v1/system/backups/${created.name}/restore`, { method: 'POST' }),
  );
  expect(result).toEqual({ restartRequired: true });
  expect(readdirSync(join(t.dir, RESTORE_DIR)).sort()).toEqual(['config.json', 'wololo.db']);
  const kinds = (await json<BackupInfo[]>(await t.request('/api/v1/system/backups'))).map((backup) => backup.kind);
  expect(kinds.sort()).toEqual(['manual', 'pre_restore']);
  const checks = await json<HealthCheck[]>(await t.request('/api/v1/system/health'));
  expect(checks.some((check) => check.source === 'backup' && check.message.includes('restart'))).toBe(true);
});

test('backups - an uploaded backup is validated and staged', async () => {
  const created = await createBackup();
  const bytes = new Uint8Array(await (await t.request(`/api/v1/system/backups/${created.name}`)).arrayBuffer());
  expect(await json<RestoreResult>(await upload(bytes))).toEqual({ restartRequired: true });
  expect(existsSync(join(t.dir, RESTORE_DIR, 'wololo.db'))).toBe(true);
});

test('backups - a restored database is staged without job log or temp paths', async () => {
  const job = insertJob(t.ctx.db, { sourcePath: '/m/a.mkv', logPath: '/config/config.json', tempPath: '/etc/hosts' });
  const created = await createBackup();
  await json<RestoreResult>(await t.request(`/api/v1/system/backups/${created.name}/restore`, { method: 'POST' }));
  const staged = new Database(join(t.dir, RESTORE_DIR, 'wololo.db'), { readonly: true });
  try {
    expect(staged.query('SELECT log_path, temp_path FROM jobs WHERE id = ?').get(job.id)).toEqual({
      log_path: null,
      temp_path: null,
    });
  } finally {
    staged.close();
  }
});

test.each([
  ['a file that is not a zip', () => upload('hello'), 422, 'unprocessable'],
  ['an empty file', () => upload(''), 400, 'validation'],
  ['a missing file field', () => upload('x', 'other'), 400, 'validation'],
  ['a JSON body', () => t.request('/api/v1/system/backups/restore', { method: 'POST', body: '{}' }), 400, 'validation'],
])('backups - uploading %s is refused without staging anything', async (_label, send, status, error) => {
  const response = await send();
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error: string; message: string };
  expect(body.error).toBe(error);
  expect(body.message).not.toContain(t.dir);
  expect(existsSync(join(t.dir, RESTORE_DIR))).toBe(false);
  expect(readdirSync(t.dir).filter((name) => name.startsWith('restore'))).toEqual([]);
});

test('POST /api/v1/system/restart - answers 204 first, then requests the restart', async () => {
  const before = t.restarts();
  const response = await t.request('/api/v1/system/restart', { method: 'POST' });
  expect(response.status).toBe(204);
  expect(t.restarts()).toBe(before);
  await eventually(() => t.restarts() === before + 1, RESTART_DELAY_MS * 8);
});

test('GET /api/v1/docs - is public HTML listing every route', async () => {
  const response = await t.app.request('/api/v1/docs');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  expect(html).toContain('<h1>Wololo API</h1>');
  expect(html).toContain('<code>/api/v1/system/backups/{name}/restore</code>');
  expect(html).not.toContain('<script');
});

test('GET /api/v1/openapi.json - needs the API key', async () => {
  expect((await t.app.request('/api/v1/openapi.json')).status).toBe(401);
});
