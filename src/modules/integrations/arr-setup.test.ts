import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary } from '../../../test/helpers/seed.ts';
import type { ArrInstance } from '../../shared/domain.ts';
import { type FakeUpstream, startFakeUpstream } from './fake-upstream.ts';

const TEMPLATE = {
  implementation: 'Webhook',
  configContract: 'WebhookSettings',
  onGrab: false,
  onDownload: false,
  onUpgrade: false,
  fields: [
    { name: 'url', value: '' },
    { name: 'method', value: 1 },
    { name: 'username', value: '' },
  ],
};

let t: TestContext;
let sonarr: FakeUpstream;
let notifications: Record<string, unknown>[];

beforeEach(() => {
  t = createTestContext();
  notifications = [];
  sonarr = startFakeUpstream({
    'GET /api/v3/system/status': () => ({ appName: 'Sonarr', version: '4.0.14' }),
    'GET /api/v3/notification': () => notifications,
    'GET /api/v3/notification/schema': () => [{ implementation: 'Discord', fields: [] }, TEMPLATE],
    'POST /api/v3/notification': (request) => {
      const created = { ...JSON.parse(request.body), id: 7 };
      notifications.push(created);
      return created;
    },
    'PUT /api/v3/notification/7': (request) => {
      const updated = JSON.parse(request.body);
      notifications = [updated];
      return updated;
    },
    'GET /api/v3/series': () => [
      { id: 4, title: 'Empty', path: '/tv/Empty', statistics: { episodeFileCount: 0 } },
      { id: 5, title: 'Severance', path: '/tv/Severance', statistics: { episodeFileCount: 1 } },
    ],
    'GET /api/v3/episodefile': (request) =>
      request.query.get('seriesId') === '5' ? [{ id: 50, relativePath: 'Season 02/Severance S02E01.mkv' }] : [],
  });
});

afterEach(() => {
  sonarr.stop();
  t.cleanup();
});

function addSonarr(): Promise<ArrInstance> {
  return t.ctx.services.arr.create({ kind: 'sonarr', name: 'Sonarr', url: sonarr.url, apiKey: 'sonarr-key' });
}

function urlField(notification: Record<string, unknown> | undefined): string {
  const fields = (notification?.fields ?? []) as { name: string; value: unknown }[];
  return String(fields.find((field) => field.name === 'url')?.value);
}

test('arr.webhook - not configured when no entry points at this instance', async () => {
  const instance = await addSonarr();
  notifications.push({ id: 1, implementation: 'Webhook', fields: [{ name: 'url', value: 'http://x/hook' }] });
  expect(await t.ctx.services.arr.webhook(instance.id)).toEqual({ configured: false, url: null, triggersOk: false });
});

test('arr.ensureWebhook - creates the webhook from the schema template', async () => {
  const instance = await addSonarr();
  const status = await t.ctx.services.arr.ensureWebhook(instance.id, 'http://wololo:8585/');

  expect(sonarr.requestsTo('POST /api/v3/notification')).toHaveLength(1);
  const created = notifications[0];
  expect(created).toMatchObject({ name: 'Wololo', onDownload: true, onUpgrade: true, onGrab: false });
  const apiKey = t.ctx.config.get().apiKey;
  expect(urlField(created)).toBe(`http://wololo:8585/api/v1/webhook/sonarr?instance=${instance.id}&apikey=${apiKey}`);
  expect(status.configured).toBe(true);
  expect(status.triggersOk).toBe(true);
  expect(status.url).not.toContain(apiKey);
});

test('arr.ensureWebhook - updates the existing entry instead of adding a second one', async () => {
  const instance = await addSonarr();
  notifications.push({
    id: 7,
    name: 'My Wololo',
    implementation: 'Webhook',
    onDownload: true,
    onUpgrade: false,
    fields: [{ name: 'url', value: `http://localhost:8585/api/v1/webhook/sonarr?instance=${instance.id}&apikey=old` }],
  });

  const status = await t.ctx.services.arr.ensureWebhook(instance.id, 'http://10.0.0.2:8585');

  expect(sonarr.requestsTo('POST /api/v3/notification')).toHaveLength(0);
  expect(sonarr.requestsTo('PUT /api/v3/notification/7')).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ id: 7, name: 'My Wololo', onUpgrade: true });
  expect(urlField(notifications[0])).toStartWith('http://10.0.0.2:8585/api/v1/webhook/sonarr?');
  expect(status.triggersOk).toBe(true);
});

test('arr.testWebhook - received when the Test event reaches Wololo during the test', async () => {
  const instance = await addSonarr();
  await t.ctx.services.arr.ensureWebhook(instance.id, 'http://wololo:8585');
  sonarr.on('POST /api/v3/notification/test', async () => {
    await t.ctx.services.webhooks.handleSonarr({ eventType: 'Test' }, instance.id);
    return {};
  });

  expect(await t.ctx.services.arr.testWebhook(instance.id)).toEqual({
    sent: true,
    received: true,
    message: 'Sonarr reached Wololo',
  });
});

test('arr.testWebhook - a test for another instance does not count', async () => {
  const instance = await addSonarr();
  await t.ctx.services.arr.ensureWebhook(instance.id, 'http://wololo:8585');
  sonarr.on('POST /api/v3/notification/test', async () => {
    await t.ctx.services.webhooks.handleSonarr({ eventType: 'Test' }, instance.id + 1);
    return {};
  });

  expect(await t.ctx.services.arr.testWebhook(instance.id)).toMatchObject({ sent: true, received: false });
});

test("arr.testWebhook - reports Sonarr's own reason when it cannot reach Wololo", async () => {
  const instance = await addSonarr();
  await t.ctx.services.arr.ensureWebhook(instance.id, 'http://localhost:8585');
  sonarr.on(
    'POST /api/v3/notification/test',
    () =>
      new Response(
        JSON.stringify([{ propertyName: 'Url', errorMessage: 'Unable to send test message: Connection refused' }]),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
  );

  expect(await t.ctx.services.arr.testWebhook(instance.id)).toEqual({
    sent: false,
    received: false,
    message: 'Unable to send test message: Connection refused',
  });
});

test('arr.testWebhook - says so when the webhook is missing', async () => {
  const instance = await addSonarr();
  expect(await t.ctx.services.arr.testWebhook(instance.id)).toMatchObject({ sent: false, received: false });
  expect(sonarr.requestsTo('POST /api/v3/notification/test')).toHaveLength(0);
});

test('arr.checkPaths - finds the first real episode file through the mapping', async () => {
  const instance = await addSonarr();
  const local = join(t.dir, 'media', 'tv');
  mkdirSync(join(local, 'Severance', 'Season 02'), { recursive: true });
  writeFileSync(join(local, 'Severance', 'Season 02', 'Severance S02E01.mkv'), '');
  await t.ctx.services.pathMappings.create({ scope: 'sonarr', remotePath: '/tv', localPath: local });

  const check = await t.ctx.services.arr.checkPaths(instance.id);

  expect(check).toMatchObject({
    ok: true,
    remotePath: '/tv/Severance/Season 02/Severance S02E01.mkv',
    localPath: join(local, 'Severance', 'Season 02', 'Severance S02E01.mkv'),
    suggestion: null,
  });
  expect(sonarr.requestsTo('GET /api/v3/episodefile').map((request) => request.query.get('seriesId'))).toEqual(['5']);
});

test('arr.checkPaths - suggests a mapping onto the library folder holding the file', async () => {
  const instance = await addSonarr();
  const local = join(t.dir, 'media', 'tv');
  mkdirSync(join(local, 'Severance', 'Season 02'), { recursive: true });
  writeFileSync(join(local, 'Severance', 'Season 02', 'Severance S02E01.mkv'), '');
  insertLibrary(t.ctx.db, { kind: 'series', roots: [local] });

  const check = await t.ctx.services.arr.checkPaths(instance.id);

  expect(check.ok).toBe(false);
  expect(check.suggestion).toEqual({ scope: 'sonarr', instanceId: instance.id, remotePath: '/tv', localPath: local });
});

test('arr.checkPaths - ok without a file to check', async () => {
  const instance = await addSonarr();
  sonarr.on('GET /api/v3/series', () => []);
  expect(await t.ctx.services.arr.checkPaths(instance.id)).toMatchObject({ ok: true, remotePath: null });
});
