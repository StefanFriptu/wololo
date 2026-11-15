import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { routesOf, splitRouteKey } from '../../shared/api-routes.ts';
import type { ArrInstance } from '../../shared/domain.ts';
import { type FakeUpstream, startFakeUpstream } from './fake-upstream.ts';
import { createPlexService } from './plex-service.ts';

const API_KEY = 'arr-secret-key';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const realFetch = globalThis.fetch;

let t: TestContext;
let radarr: FakeUpstream;
let plexTv: FakeUpstream;
let external: string[];

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

beforeEach(() => {
  external = [];
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
    external.push(url.href);
    return Promise.reject(new Error(`network call outside the test: ${url.href}`));
  }, realFetch);
  t = createTestContext();
  plexTv = startFakeUpstream({
    'POST /api/v2/pins': () => ({ id: 1, code: 'ABCD', authToken: null, expiresAt: '2999-01-01T00:00:00Z' }),
    'GET /api/v2/pins/1': () => ({ id: 1, code: 'ABCD', authToken: null, expiresAt: '2999-01-01T00:00:00Z' }),
  });
  t.ctx.services.plex = createPlexService(t.ctx, { plexTvUrl: plexTv.url });
  radarr = startFakeUpstream({
    'GET /api/v3/system/status': () => ({ appName: 'Radarr', version: '5.20.0' }),
    'GET /api/v3/rootfolder': () => [{ id: 1, path: '/movies', freeSpace: 5 }],
    'GET /api/v3/qualityprofile': () => [{ id: 1, name: 'Any' }],
    'GET /api/v3/movie': () => [],
    'GET /api/v3/movie/lookup': () => [{ title: 'Heat', year: 1995, tmdbId: 949 }],
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  radarr.stop();
  plexTv.stop();
  t.cleanup();
});

test('integrations routes - every route answers without a server error or a network call', async () => {
  const keys = routesOf('integrations');
  expect(keys.length).toBeGreaterThan(0);
  const statuses: Record<string, number> = {};
  for (const key of keys) {
    const { method, path } = splitRouteKey(key);
    const response = await t.request(path.replace(':id', '1'), {
      method,
      body: method === 'GET' ? undefined : '{}',
    });
    statuses[key] = response.status;
  }
  expect(Object.entries(statuses).filter(([, status]) => status >= 500)).toEqual([]);
  expect(external).toEqual([]);
  expect(plexTv.requestsTo('POST /api/v2/pins')).toHaveLength(1);
});

test('arr routes - CRUD, test, root folders, profiles and lookup without leaking the key', async () => {
  const body = { kind: 'radarr', name: 'Radarr', url: radarr.url, apiKey: API_KEY };
  const created = await t.request('/api/v1/arr', { method: 'POST', body: JSON.stringify(body) });
  expect(created.status).toBe(200);
  const instance = (await created.json()) as ArrInstance;
  expect(JSON.stringify(instance)).not.toContain(API_KEY);

  const listed = await (await t.request('/api/v1/arr')).text();
  expect(listed).not.toContain(API_KEY);
  const tested = await t.request('/api/v1/arr/test', {
    method: 'POST',
    body: JSON.stringify({ ...body, id: instance.id, apiKey: '********' }),
  });
  expect(await tested.json()).toMatchObject({ ok: true, version: '5.20.0' });
  expect(await (await t.request(`/api/v1/arr/${instance.id}/rootfolders`)).json()).toMatchObject([
    { id: 1, path: '/movies', freeBytes: 5 },
  ]);
  expect(await (await t.request(`/api/v1/arr/${instance.id}/qualityprofiles`)).json()).toEqual([
    { id: 1, name: 'Any' },
  ]);
  const lookup = await t.request(`/api/v1/arr/${instance.id}/lookup?term=Heat&year=1995`);
  expect(await lookup.json()).toEqual([
    { title: 'Heat', year: 1995, tmdbId: 949, imdbId: null, score: 1, radarrMovieId: null },
  ]);

  const updated = await t.request(`/api/v1/arr/${instance.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...body, name: 'Movies', apiKey: '********' }),
  });
  expect(await updated.json()).toMatchObject({ name: 'Movies', apiKey: '********' });
  expect((await t.request(`/api/v1/arr/${instance.id}`, { method: 'DELETE' })).status).toBe(204);
  expect((await t.request(`/api/v1/arr/${instance.id}`)).status).toBe(404);
});

test('arr routes - invalid input is a validation error', async () => {
  const badUrl = await t.request('/api/v1/arr', {
    method: 'POST',
    body: JSON.stringify({ kind: 'radarr', name: 'x', url: 'radarr:7878', apiKey: 'k' }),
  });
  expect(badUrl.status).toBe(400);
  const badKind = await t.request('/api/v1/arr', {
    method: 'POST',
    body: JSON.stringify({ kind: 'lidarr', name: 'x', url: 'http://x', apiKey: 'k' }),
  });
  expect(badKind.status).toBe(400);
  expect((await t.request('/api/v1/arr/1/lookup')).status).toBe(400);
});

test('arr routes - upstream failure answers 502 without internals', async () => {
  const created = await t.request('/api/v1/arr', {
    method: 'POST',
    body: JSON.stringify({ kind: 'radarr', name: 'Radarr', url: radarr.url, apiKey: API_KEY }),
  });
  const { id } = (await created.json()) as ArrInstance;
  radarr.on('GET /api/v3/qualityprofile', () => new Response('stack trace here', { status: 500 }));
  const response = await t.request(`/api/v1/arr/${id}/qualityprofiles`);
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).toContain('upstream');
  expect(text).not.toContain('stack trace');
  expect(text).not.toContain(API_KEY);
});
