import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTE_META, splitRouteKey } from '../../src/shared/api-routes.ts';
import type { GeneralConfigView, RouteKey } from '../../src/shared/api-types.ts';
import type { LogEntry } from '../../src/shared/domain.ts';
import type { Settings } from '../../src/shared/settings.ts';
import { createTestContext, TEST_API_KEY, type TestContext } from '../helpers/context.ts';

const SVELTEKIT_INDEX = `<!doctype html><html><head><link rel="icon" href="/favicon.svg" />
<link href="/_app/immutable/entry/start.js" rel="modulepreload"></head><body><script>
__sveltekit_x = { base: "", version: "1" };
Promise.all([import("/_app/immutable/entry/start.js"), import("/_app/immutable/entry/app.js")]);
</script></body></html>`;

function urlBaseContext(template: string): TestContext {
  const web = mkdtempSync(join(tmpdir(), 'wololo-web-'));
  mkdirSync(join(web, '_app', 'immutable', 'entry'), { recursive: true });
  writeFileSync(join(web, 'index.html'), template);
  writeFileSync(join(web, '_app', 'immutable', 'entry', 'start.js'), 'export {}');
  const based = createTestContext({ env: { WOLOLO__URL_BASE: 'wololo/', WOLOLO_WEB_DIR: web } });
  return {
    ...based,
    cleanup: () => {
      based.cleanup();
      rmSync(web, { recursive: true, force: true });
    },
  };
}

let t: TestContext;

beforeAll(() => {
  t = createTestContext();
  const web = join(t.dir, 'web');
  mkdirSync(join(web, '_app', 'immutable'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Wololo</title></head><body></body></html>');
  writeFileSync(join(web, '_app', 'immutable', 'app.js'), 'export {}');
});

afterAll(() => t.cleanup());

describe('route table', () => {
  test.each(Object.keys(API_ROUTE_META) as RouteKey[])('%s is registered', (key) => {
    const { method, path } = splitRouteKey(key);
    expect(t.app.routes.some((entry) => entry.method === method && entry.path === path)).toBe(true);
  });

  test.each(Object.keys(API_ROUTE_META) as RouteKey[])('%s has exactly one handler', (key) => {
    const { method, path } = splitRouteKey(key);
    expect(t.app.routes.filter((entry) => entry.method === method && entry.path === path)).toHaveLength(1);
  });

  test('every route is served by a real handler: no 501 and no network call', async () => {
    const realFetch = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        outbound.push(String(input instanceof Request ? input.url : input));
        throw new Error('network disabled in this test');
      },
      { preconnect: realFetch.preconnect },
    );
    const sweep = createTestContext();
    try {
      const statuses: Record<string, number> = {};
      for (const key of Object.keys(API_ROUTE_META) as RouteKey[]) {
        if (API_ROUTE_META[key].responseType === 'sse') continue;
        const { method, path } = splitRouteKey(key);
        const response = await sweep.request(path.replace(':id', '999999').replace(':name', 'library_scan'), {
          method,
          ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
        });
        statuses[key] = response.status;
      }
      expect(Object.keys(statuses).length).toBeGreaterThan(80);
      expect(Object.entries(statuses).filter(([, status]) => status === 501)).toEqual([]);
      expect(outbound.filter((url) => !url.startsWith('https://plex.tv/'))).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      sweep.cleanup();
    }
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
    expect((await t.app.request(`/api/v1/settings?apikey=${TEST_API_KEY}`)).status).toBe(200);
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
    const general = (await (await t.request('/api/v1/settings/general')).json()) as GeneralConfigView;
    expect(general.apiKey).toBe(TEST_API_KEY);
    expect(general.runningPort).toBe(general.port);
    const regenerate = await t.request('/api/v1/settings/general/apikey', {
      method: 'POST',
    });
    expect(regenerate.status).toBe(409);
  });

  test('general settings - runningPort keeps the boot port after a port change', async () => {
    const before = (await (await t.request('/api/v1/settings/general')).json()) as GeneralConfigView;
    const put = (port: number) =>
      t.request('/api/v1/settings/general', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    try {
      const changed = (await (await put(before.port + 1)).json()) as GeneralConfigView;
      expect(changed.port).toBe(before.port + 1);
      expect(changed.runningPort).toBe(before.port);
      expect(changed.restartRequired).toBe(true);
    } finally {
      await put(before.port);
    }
  });

  test('general settings - a bind address on no local interface is refused and not saved', async () => {
    const put = (bindAddress: string) =>
      t.request('/api/v1/settings/general', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindAddress }),
      });
    expect(t.ctx.localAddresses()).toContain('127.0.0.1');
    expect(t.ctx.localAddresses()).not.toContain('203.0.113.7');
    try {
      const refused = await put('203.0.113.7');
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain('203.0.113.7 is not on any interface');
      expect(t.ctx.config.get().bindAddress).toBe('*');
      const loopback = (await (await put('127.0.0.1')).json()) as GeneralConfigView;
      expect(loopback.bindAddress).toBe('127.0.0.1');
      expect(typeof loopback.isDocker).toBe('boolean');
    } finally {
      await put('*');
    }
  });

  test('logs endpoint returns ring buffer entries', async () => {
    t.ctx.logs.logger('test').info('hello from test');
    const entries = (await (await t.request('/api/v1/system/logs?module=test')).json()) as LogEntry[];
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
    while (!text.includes('job.removed')) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('data: {"jobId":42}');
    await reader.cancel();
  });
});

describe('SPA', () => {
  test('serves index.html with injected runtime config for client routes, without the key by default', async () => {
    for (const path of ['/', '/activity/queue', '/library/12']) {
      const response = await t.app.request(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('window.__WOLOLO__=');
      expect(html).toContain('"apiKey":""');
      expect(html).not.toContain(TEST_API_KEY);
    }
  });

  test('authentication "disabled" injects the API key', async () => {
    const open = createTestContext({ env: { WOLOLO__AUTHENTICATION: 'disabled' } });
    try {
      expect(await (await open.app.request('/')).text()).toContain(TEST_API_KEY);
    } finally {
      open.cleanup();
    }
  });

  const fromLoopback = { server: { requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 50000 }) } };
  const spaFrom = async (path: string, headers: Record<string, string>) =>
    (await t.app.request(path, { headers }, fromLoopback)).text();

  test('spa key exposure - local Host from loopback gets the key on the root and deep links', async () => {
    for (const host of ['localhost:8585', '192.168.1.5:7878', 'wololo', 'nas.lan']) {
      for (const path of ['/', '/settings/general']) {
        expect(await spaFrom(path, { host })).toContain(TEST_API_KEY);
      }
    }
  });

  test('spa key exposure - public Host from loopback gets an empty key', async () => {
    expect(await spaFrom('/', { host: 'localhost' })).toContain(TEST_API_KEY);
    for (const path of ['/', '/settings/general']) {
      const html = await spaFrom(path, { host: 'evil.example.com' });
      expect(html).toContain('"apiKey":""');
      expect(html).not.toContain(TEST_API_KEY);
    }
  });

  test.each([
    'x-forwarded-for',
    'forwarded',
    'x-real-ip',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'via',
    'cf-connecting-ip',
    'true-client-ip',
    'x-client-ip',
  ])('spa key exposure - %s header withholds the key', async (header) => {
    expect(await spaFrom('/', { host: 'localhost' })).toContain(TEST_API_KEY);
    const html = await spaFrom('/settings/general', { host: 'localhost', [header]: '1.2.3.4' });
    expect(html).toContain('"apiKey":""');
  });

  test('serves assets with immutable caching and 404s missing assets', async () => {
    const asset = await t.app.request('/_app/immutable/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await t.app.request('/_app/immutable/missing.js')).status).toBe(404);
    expect((await t.app.request('/../../etc/passwd')).status).not.toBe(500);
  });
});

describe('security headers', () => {
  const expectSecurityHeaders = (response: Response) => {
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  };

  test('security headers - set on SPA and API responses', async () => {
    for (const path of ['/', '/library/12', '/_app/immutable/app.js', '/_app/immutable/missing.js']) {
      expectSecurityHeaders(await t.app.request(path));
    }
    expectSecurityHeaders(await t.request('/api/v1/system/status'));
    expectSecurityHeaders(await t.request('/api/v1/nope'));
    expectSecurityHeaders(await t.app.request('/api/v1/system/status'));
  });

  test('security headers - set under a URL base and on its root redirect', async () => {
    const based = urlBaseContext(SVELTEKIT_INDEX);
    try {
      for (const path of ['/', '/wololo/', '/wololo/_app/immutable/entry/start.js', '/wololo/health', '/elsewhere']) {
        expectSecurityHeaders(await based.app.request(path));
      }
    } finally {
      based.cleanup();
    }
  });
});

describe('URL base', () => {
  test('prefixes asset URLs and the SvelteKit base, serves assets under the base', async () => {
    const based = urlBaseContext(SVELTEKIT_INDEX);
    try {
      const html = await (await based.app.request('/wololo/library')).text();
      expect(html).not.toMatch(/["(]\/_app\//);
      expect(html).toContain('href="/wololo/favicon.svg"');
      expect(html).toContain('import("/wololo/_app/immutable/entry/start.js")');
      expect(html).toContain('base: "/wololo"');
      expect((await based.app.request('/wololo/_app/immutable/entry/start.js')).status).toBe(200);
      expect((await based.app.request('/wololo/health')).status).toBe(200);
    } finally {
      based.cleanup();
    }
  });

  const builtIndex = join(import.meta.dir, '..', '..', 'web', 'build', 'index.html');
  test.skipIf(!existsSync(builtIndex))('the real web build has no root-absolute asset URL left', async () => {
    const based = urlBaseContext(readFileSync(builtIndex, 'utf8'));
    try {
      const html = await (await based.app.request('/wololo/')).text();
      expect(html).not.toMatch(/["'(]\/_app\//);
      expect(html).not.toContain('base: ""');
    } finally {
      based.cleanup();
    }
  });
});
