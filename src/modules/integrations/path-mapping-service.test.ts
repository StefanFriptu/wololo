import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertArrInstance } from '../../../test/helpers/seed.ts';
import type { PathMapping } from '../../shared/domain.ts';
import { applicableMappings } from './path-mapping-service.ts';

let t: TestContext;

beforeEach(() => {
  t = createTestContext();
});

afterEach(() => t.cleanup());

test('pathMappings.create - trims trailing separators', async () => {
  const created = await t.ctx.services.pathMappings.create({
    scope: 'plex',
    remotePath: '/media/',
    localPath: '/data/media/',
  });
  expect(created).toEqual({
    id: created.id,
    scope: 'plex',
    instanceId: null,
    remotePath: '/media',
    localPath: '/data/media',
  });
  expect(await t.ctx.services.pathMappings.list()).toEqual([created]);
});

test.each([
  ['relative local path', { scope: 'plex', remotePath: '/m', localPath: 'data' }, 'validation'],
  ['instance on a plex mapping', { scope: 'plex', instanceId: 1, remotePath: '/m', localPath: '/d' }, 'validation'],
  ['unknown instance', { scope: 'radarr', instanceId: 99, remotePath: '/m', localPath: '/d' }, 'unprocessable'],
] as const)('pathMappings.create - rejects %s', async (_name, input, code) => {
  await expect(t.ctx.services.pathMappings.create(input)).rejects.toMatchObject({ code });
});

test('pathMappings.create - instance of the other kind is unprocessable', async () => {
  const sonarr = insertArrInstance(t.ctx.db, { kind: 'sonarr' });
  const create = t.ctx.services.pathMappings.create({
    scope: 'radarr',
    instanceId: sonarr,
    remotePath: '/m',
    localPath: '/d',
  });
  await expect(create).rejects.toMatchObject({ code: 'unprocessable' });
});

test('pathMappings.create - duplicate remote path in the same scope is a conflict', async () => {
  await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/m', localPath: '/a' });
  await expect(
    t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/m/', localPath: '/b' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await t.ctx.services.pathMappings.create({ scope: 'sonarr', remotePath: '/m', localPath: '/b' });
});

test('pathMappings.update - changes a mapping, not found for unknown ids', async () => {
  const created = await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/m', localPath: '/a' });
  const updated = await t.ctx.services.pathMappings.update(created.id, {
    scope: 'radarr',
    remotePath: '/m',
    localPath: '/b',
  });
  expect(updated.localPath).toBe('/b');
  await expect(
    t.ctx.services.pathMappings.update(999, { scope: 'radarr', remotePath: '/x', localPath: '/b' }),
  ).rejects.toMatchObject({ code: 'not_found' });
});

test('pathMappings.remove - deletes once', async () => {
  const created = await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/m', localPath: '/a' });
  await t.ctx.services.pathMappings.remove(created.id);
  await expect(t.ctx.services.pathMappings.remove(created.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('pathMappings.toLocal/toRemote - round trip, scope and instance aware', async () => {
  const instanceId = insertArrInstance(t.ctx.db, { kind: 'radarr' });
  await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/vault', localPath: '/data' });
  await t.ctx.services.pathMappings.create({ scope: 'radarr', instanceId, remotePath: '/vault', localPath: '/uhd' });
  await t.ctx.services.pathMappings.create({ scope: 'plex', remotePath: '/media', localPath: '/data' });
  const { toLocal, toRemote } = t.ctx.services.pathMappings;
  expect(await toLocal('radarr', '/vault/a.mkv')).toBe('/data/a.mkv');
  expect(await toLocal('radarr', '/vault/a.mkv', instanceId)).toBe('/uhd/a.mkv');
  expect(await toLocal('sonarr', '/vault/a.mkv')).toBe('/vault/a.mkv');
  expect(await toRemote('plex', '/data/a.mkv')).toBe('/media/a.mkv');
  expect(await toRemote('radarr', '/uhd/a.mkv', instanceId)).toBe('/vault/a.mkv');
});

function mapping(id: number, overrides: Partial<PathMapping>): PathMapping {
  return { id, scope: 'radarr', instanceId: null, remotePath: '/r', localPath: '/l', ...overrides };
}

test('applicableMappings - instance-specific first, other instances and scopes excluded', () => {
  const mappings = [
    mapping(1, {}),
    mapping(2, { instanceId: 5 }),
    mapping(3, { instanceId: 6 }),
    mapping(4, { scope: 'sonarr' }),
  ];
  expect(applicableMappings(mappings, 'radarr', 5).map((m) => m.id)).toEqual([2, 1]);
  expect(applicableMappings(mappings, 'radarr', null).map((m) => m.id)).toEqual([1]);
});

test('pathmappings routes - CRUD over HTTP with validation', async () => {
  const created = await t.request('/api/v1/pathmappings', {
    method: 'POST',
    body: JSON.stringify({ scope: 'plex', remotePath: '/media', localPath: '/data' }),
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as PathMapping;
  const updated = await t.request(`/api/v1/pathmappings/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ scope: 'plex', remotePath: '/media', localPath: '/data2' }),
  });
  expect(await updated.json()).toMatchObject({ localPath: '/data2' });
  expect(await (await t.request('/api/v1/pathmappings')).json()).toHaveLength(1);
  expect((await t.request(`/api/v1/pathmappings/${id}`, { method: 'DELETE' })).status).toBe(204);
  expect((await t.request(`/api/v1/pathmappings/${id}`, { method: 'DELETE' })).status).toBe(404);
  const invalid = await t.request('/api/v1/pathmappings', { method: 'POST', body: '{"scope":"emby"}' });
  expect(invalid.status).toBe(400);
});
