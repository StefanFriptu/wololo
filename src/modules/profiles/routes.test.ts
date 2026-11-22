import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertLibrary } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import type { CodecCatalog, ProfileTemplate, ProfileWithUsage } from '../../shared/api-types.ts';
import { templateDefinition } from './profileTemplates.ts';

let t: TestContext;

beforeEach(() => {
  t = createTestContext({
    overrides: { media: stubService<MediaService>('media', { invalidateRules: async () => 0 }) },
  });
});

afterEach(() => t.cleanup());

function send(method: string, path: string, body?: unknown) {
  return t.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function profileBody(overrides: Record<string, unknown> = {}, audio: Record<string, unknown> = {}) {
  const definition = templateDefinition('basic');
  return { name: 'Bedroom', definition: { ...definition, audio: { ...definition.audio, ...audio } }, ...overrides };
}

test('GET /api/v1/profiles - a fresh install lists no profile', async () => {
  const response = await t.request('/api/v1/profiles');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

test('GET /api/v1/profiles/templates - every template creates a valid profile', async () => {
  const response = await t.request('/api/v1/profiles/templates');
  expect(response.status).toBe(200);
  const templates = (await response.json()) as ProfileTemplate[];
  expect(templates.map((template) => template.id)).toEqual(['basic', 'dolby', 'lossless', 'everything', 'blank']);
  for (const template of templates) {
    const created = await send('POST', '/api/v1/profiles', { name: template.name, definition: template.definition });
    expect(created.status).toBe(200);
  }
});

test('POST /api/v1/profiles - creates a profile with normalised codec names', async () => {
  const response = await send(
    'POST',
    '/api/v1/profiles',
    profileBody({}, { allowedCodecs: [' AC3', 'aac', 'PCM_*', 'aac'] }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as ProfileWithUsage;
  expect(body).toMatchObject({ name: 'Bedroom', description: '', version: 1 });
  expect(body.definition.audio.allowedCodecs).toEqual(['ac3', 'aac', 'pcm_*']);
});

test.each([
  ['a target codec the profile does not allow', profileBody({}, { allowedCodecs: ['aac'], targetCodec: 'ac3' })],
  ['an ac3 bitrate above 640 kbps', profileBody({}, { bitrates: { mono: 192, stereo: 448, surround: 768 } })],
  ['an unknown target codec', profileBody({}, { targetCodec: 'dts' })],
  ['more than 8 channels', profileBody({}, { maxChannels: 12 })],
  ['an invalid codec name', profileBody({}, { allowedCodecs: ['ac3', 'dts hd'] })],
  ['an empty name', profileBody({ name: '  ' })],
  ['a missing definition', { name: 'Bedroom' }],
])('POST /api/v1/profiles - rejects %s', async (_name, body) => {
  const response = await send('POST', '/api/v1/profiles', body);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe('validation');
});

test('POST /api/v1/profiles - accepts e-ac3 bitrates above the ac3 ceiling', async () => {
  const response = await send(
    'POST',
    '/api/v1/profiles',
    profileBody(
      {},
      { allowedCodecs: ['eac3'], targetCodec: 'eac3', bitrates: { mono: 192, stereo: 448, surround: 1024 } },
    ),
  );
  expect(response.status).toBe(200);
});

test('POST /api/v1/profiles - a duplicate name answers 409', async () => {
  await send('POST', '/api/v1/profiles', profileBody());
  const response = await send('POST', '/api/v1/profiles', profileBody());
  expect(response.status).toBe(409);
});

test('GET /api/v1/profiles/codecs - is not captured by the :id route', async () => {
  const response = await t.request('/api/v1/profiles/codecs');
  expect(response.status).toBe(200);
  const body = (await response.json()) as CodecCatalog;
  expect(body.audio.some((codec) => codec.codec === 'truehd' && codec.lossless)).toBe(true);
});

test('GET /api/v1/profiles/:id - answers 404 for an unknown id and 400 for a bad one', async () => {
  expect((await t.request('/api/v1/profiles/999')).status).toBe(404);
  expect((await t.request('/api/v1/profiles/abc')).status).toBe(400);
});

test('PUT /api/v1/profiles/:id - bumps the version when the definition changes', async () => {
  const created = (await (await send('POST', '/api/v1/profiles', profileBody())).json()) as ProfileWithUsage;
  const response = await send('PUT', `/api/v1/profiles/${created.id}`, profileBody({}, { maxChannels: 2 }));
  expect(response.status).toBe(200);
  expect(((await response.json()) as ProfileWithUsage).version).toBe(2);
});

test('DELETE /api/v1/profiles/:id - answers 204, then 404', async () => {
  const created = (await (await send('POST', '/api/v1/profiles', profileBody())).json()) as ProfileWithUsage;
  const response = await send('DELETE', `/api/v1/profiles/${created.id}`);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect((await t.request(`/api/v1/profiles/${created.id}`)).status).toBe(404);
});

test('DELETE /api/v1/profiles/:id - an assigned profile answers 409', async () => {
  const created = (await (await send('POST', '/api/v1/profiles', profileBody())).json()) as ProfileWithUsage;
  insertLibrary(t.ctx.db, { profileIds: [created.id] });
  const response = await send('DELETE', `/api/v1/profiles/${created.id}`);
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toMatch(/SQL|sqlite/i);
});

test('POST /api/v1/profiles/:id/clone - clones under a new name', async () => {
  const source = (await (await send('POST', '/api/v1/profiles', profileBody())).json()) as ProfileWithUsage;
  const response = await send('POST', `/api/v1/profiles/${source.id}/clone`, { name: 'Living room' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'Living room', version: 1 });
  expect((await send('POST', `/api/v1/profiles/${source.id}/clone`, {})).status).toBe(400);
});

test('GET /api/v1/profiles - requires the api key', async () => {
  const response = await t.app.request('/api/v1/profiles');
  expect(response.status).toBe(401);
});
