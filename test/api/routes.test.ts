import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ROUTE_META, splitRouteKey } from '../../src/shared/api-routes.ts';
import type {
  GeneralConfigView,
  RouteKey,
} from '../../src/shared/api-types.ts';
import type { LogEntry } from '../../src/shared/domain.ts';
import type { Settings } from '../../src/shared/settings.ts';
import {
  createTestContext,
  TEST_API_KEY,
  type TestContext,
} from '../helpers/context.ts';

let t: TestContext;

beforeAll(() => {
  t = createTestContext();
  const web = join(t.dir, 'web');
  mkdirSync(join(web, '_app', 'immutable'), { recursive: true });
  writeFileSync(
    join(web, 'index.html'),
    '<!doctype html><html><head><title>Wololo</title></head><body></body></html>',
  );
  writeFileSync(join(web, '_app', 'immutable', 'app.js'), 'export {}');
});

afterAll(() => t.cleanup());

const concretePath = (path: string) =>
  path.replace(/:name/g, 'library_scan').replace(/:[a-zA-Z]+/g, '1');

describe('route table', () => {
  const keys = (Object.keys(API_ROUTE_META) as RouteKey[]).filter(
    (key) => API_ROUTE_META[key].responseType !== 'sse',
  );

  test.each(keys)('%s is registered', async (key) => {
    const { method, path } = splitRouteKey(key);
    const response = await t.request(concretePath(path), {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    const body =
      response.status === 404
        ? ((await response.json()) as { message: string })
        : null;
    expect(body?.message ?? '').not.toStartWith('no route for');
    expect(response.status).not.toBe(405);
  });

  test('unknown API path returns a JSON 404', async () => {
    const response = await t.request('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('auth', () => {
  test('/health needs no API key', async () => {
    const response = await t.app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  test('API routes reject missing or wrong keys', async () => {
    expect((await t.app.request('/api/v1/settings')).status).toBe(401);
    expect(
      (
        await t.app.request('/api/v1/settings', {
          headers: { 'x-api-key': 'nope' },
        })
      ).status,
    ).toBe(401);
  });

  test('API key accepted as header, query parameter and bearer token', async () => {
    expect(
      (
        await t.app.request('/api/v1/settings', {
          headers: { 'x-api-key': TEST_API_KEY },
        })
      ).status,
    ).toBe(200);
    expect(
      (await t.app.request(`/api/v1/settings?apikey=${TEST_API_KEY}`)).status,
    ).toBe(200);
    expect(
      (
        await t.app.request('/api/v1/settings', {
          headers: { authorization: `Bearer ${TEST_API_KEY}` },
        })
      ).status,
    ).toBe(200);
  });
});

describe('core routes', () => {
  test('settings round trip with validation', async () => {
    const put = await t.request('/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ processing: { concurrency: 2 } }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as Settings).processing.concurrency).toBe(2);
    const bad = await t.request('/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ processing: { concurrency: 'two' } }),
    });
    expect(bad.status).toBe(400);
  });

  test('general settings expose the API key and refuse env-locked changes', async () => {
    const general = (await (
      await t.request('/api/v1/settings/general')
    ).json()) as GeneralConfigView;
    expect(general.apiKey).toBe(TEST_API_KEY);
    const regenerate = await t.request('/api/v1/settings/general/apikey', {
      method: 'POST',
    });
    expect(regenerate.status).toBe(409);
  });

  test('logs endpoint returns ring buffer entries', async () => {
    t.ctx.logs.logger('test').info('hello from test');
    const entries = (await (
      await t.request('/api/v1/system/logs?module=test')
    ).json()) as LogEntry[];
    expect(entries[0]).toMatchObject({
      module: 'test',
      message: 'hello from test',
    });
  });

  test('events stream starts with a hello frame and forwards bus events', async () => {
    const response = await t.request('/api/v1/events');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain('event: hello');
    t.ctx.events.emit('job.removed', { jobId: 42 });
    while (!text.includes('job.removed'))
      text += decoder.decode((await reader.read()).value);
    expect(text).toContain('data: {"jobId":42}');
    await reader.cancel();
  });
});

describe('SPA', () => {
  test('serves index.html with injected runtime config for client routes', async () => {
    for (const path of ['/', '/activity/queue', '/library/12']) {
      const response = await t.app.request(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('window.__WOLOLO__=');
      expect(html).toContain(TEST_API_KEY);
    }
  });

  test('serves assets with immutable caching and 404s missing assets', async () => {
    const asset = await t.app.request('/_app/immutable/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await t.app.request('/_app/immutable/missing.js')).status).toBe(
      404,
    );
    expect((await t.app.request('/../../etc/passwd')).status).not.toBe(500);
  });
});
