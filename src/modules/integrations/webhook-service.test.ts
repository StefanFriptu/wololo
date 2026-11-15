import { afterEach, expect, test } from 'bun:test';
import { createTestContext, TEST_API_KEY, type TestContext } from '../../../test/helpers/context.ts';
import { insertArrInstance } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { CheckAction, CheckResult, MediaRefs, MediaService } from '../../contracts/probe-scan.ts';
import type { MediaFileSummary, WebhookResponse } from '../../shared/api-types.ts';
import type { DeepPartial, Settings } from '../../shared/settings.ts';

interface CheckCall {
  path: string;
  refs: MediaRefs;
}

let t: TestContext;
let calls: CheckCall[];

function summary(id: number, path: string): MediaFileSummary {
  return {
    id,
    libraryId: 1,
    path,
    relativePath: path,
    kind: 'file',
    sizeBytes: 1,
    durationSec: null,
    status: 'needs_work',
    statusReason: null,
    videoCodec: null,
    audioCodecs: [],
    subtitleLanguages: [],
    failingCodecs: [],
    planAction: null,
    lastJobId: null,
    probedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function setup(
  options: { action?: (path: string) => CheckAction | Error; settings?: DeepPartial<Settings> } = {},
): TestContext {
  calls = [];
  const checkPath = async (path: string, refs: MediaRefs): Promise<CheckResult> => {
    calls.push({ path, refs });
    const action = options.action?.(path) ?? 'queued';
    if (action instanceof Error) throw action;
    return { action, mediaFile: summary(calls.length, path), jobId: null, message: `${action}: ${path}` };
  };
  t = createTestContext({
    settings: options.settings,
    overrides: { media: stubService<MediaService>('media', { checkPath }) },
  });
  return t;
}

afterEach(() => t.cleanup());

async function post(kind: 'radarr' | 'sonarr', body: unknown, query = ''): Promise<WebhookResponse> {
  const response = await t.request(`/api/v1/webhook/${kind}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as WebhookResponse;
}

const RADARR_DOWNLOAD = {
  eventType: 'Download',
  instanceName: 'Radarr',
  applicationUrl: '',
  isUpgrade: true,
  movie: {
    id: 7,
    title: 'Heat',
    year: 1995,
    folderPath: '/vault/movies/Heat (1995)',
    tmdbId: 949,
    originalLanguage: { id: 1, name: 'English' },
  },
  movieFile: { id: 3, relativePath: 'Heat.mkv', path: '/vault/movies/Heat (1995)/Heat.mkv', size: 10 },
  downloadClient: 'qBittorrent',
  downloadId: 'ABCDEF',
};

test('webhook radarr - Test event is acknowledged without checking files', async () => {
  setup();
  expect(await post('radarr', { eventType: 'Test' })).toEqual({
    accepted: true,
    action: 'test',
    mediaFileIds: [],
    message: 'radarr test received',
  });
  expect(calls).toHaveLength(0);
});

test.each(['Grab', 'Rename', 'Health', 'HealthRestored', 'MovieDelete', 'ApplicationUpdate', 'SomethingNew'])(
  'webhook radarr - %s event is a 200 no-op',
  async (eventType) => {
    setup();
    insertArrInstance(t.ctx.db, { name: 'Radarr' });
    const result = await post('radarr', { eventType, movie: RADARR_DOWNLOAD.movie });
    expect(result).toMatchObject({ accepted: true, action: 'ignored' });
    expect(calls).toHaveLength(0);
  },
);

test('webhook radarr - Download maps the path and passes arr ref and language', async () => {
  setup();
  const instanceId = insertArrInstance(t.ctx.db, { name: 'Radarr' });
  await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/vault', localPath: '/data' });
  const result = await post('radarr', RADARR_DOWNLOAD, `?instance=${instanceId}`);
  expect(result).toEqual({
    accepted: true,
    action: 'queued',
    mediaFileIds: [1],
    message: 'queued: /data/movies/Heat (1995)/Heat.mkv',
  });
  expect(calls).toEqual([
    {
      path: '/data/movies/Heat (1995)/Heat.mkv',
      refs: {
        trigger: 'webhook',
        arr: { instanceId, kind: 'radarr', itemId: 7, fileId: 3 },
        originalLanguage: 'eng',
      },
    },
  ]);
});

test('webhook radarr - instance-specific mapping applies only to that instance', async () => {
  setup();
  const first = insertArrInstance(t.ctx.db, { name: 'A' });
  const second = insertArrInstance(t.ctx.db, { name: 'B' });
  await t.ctx.services.pathMappings.create({
    scope: 'radarr',
    instanceId: second,
    remotePath: '/vault',
    localPath: '/four-k',
  });
  await post('radarr', RADARR_DOWNLOAD, `?instance=${first}`);
  await post('radarr', RADARR_DOWNLOAD, `?instance=${second}`);
  expect(calls.map((call) => call.path)).toEqual([
    '/vault/movies/Heat (1995)/Heat.mkv',
    '/four-k/movies/Heat (1995)/Heat.mkv',
  ]);
});

test('webhook radarr - without ?instance the only enabled instance is used', async () => {
  setup();
  const instanceId = insertArrInstance(t.ctx.db, { name: 'Main' });
  await post('radarr', { ...RADARR_DOWNLOAD, instanceName: 'Something else' });
  expect(calls[0]?.refs.arr?.instanceId).toBe(instanceId);
});

test('webhook radarr - several instances resolve by instanceName', async () => {
  setup();
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  const fourK = insertArrInstance(t.ctx.db, { name: 'Radarr 4K' });
  await post('radarr', { ...RADARR_DOWNLOAD, instanceName: 'Radarr 4K' });
  expect(calls[0]?.refs.arr?.instanceId).toBe(fourK);
});

test('webhook radarr - unresolvable instance answers error without checking', async () => {
  setup();
  insertArrInstance(t.ctx.db, { name: 'A' });
  insertArrInstance(t.ctx.db, { name: 'B' });
  const result = await post('radarr', { ...RADARR_DOWNLOAD, instanceName: 'C' });
  expect(result).toMatchObject({ accepted: false, action: 'error' });
  expect(result.message).toContain('?instance=');
  expect(calls).toHaveLength(0);
});

test('webhook radarr - a Sonarr instance id is rejected', async () => {
  setup();
  const sonarrId = insertArrInstance(t.ctx.db, { kind: 'sonarr', name: 'S' });
  const result = await post('radarr', RADARR_DOWNLOAD, `?instance=${sonarrId}`);
  expect(result).toMatchObject({ action: 'error', message: `instance ${sonarrId} is a sonarr instance` });
});

test('webhook radarr - disabled instance is ignored', async () => {
  setup();
  const instanceId = insertArrInstance(t.ctx.db, { name: 'Radarr' });
  const current = await t.ctx.services.arr.get(instanceId);
  await t.ctx.services.arr.update(instanceId, { ...current, enabled: false });
  const result = await post('radarr', RADARR_DOWNLOAD, `?instance=${instanceId}`);
  expect(result).toMatchObject({ accepted: true, action: 'ignored' });
  expect(calls).toHaveLength(0);
});

test('webhook radarr - checkOnImport off ignores imports', async () => {
  setup({ settings: { media: { checkOnImport: false } } });
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  expect(await post('radarr', RADARR_DOWNLOAD)).toMatchObject({ action: 'ignored' });
  expect(calls).toHaveLength(0);
});

test('webhook radarr - Download without a file path is an error', async () => {
  setup();
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  const { movieFile: _file, ...withoutFile } = RADARR_DOWNLOAD;
  const result = await post('radarr', { ...withoutFile, movie: { id: 7, title: 'Heat' } });
  expect(result).toMatchObject({ accepted: false, action: 'error', message: 'the payload names no imported file' });
});

test('webhook radarr - malformed known fields answer 200 with error', async () => {
  setup();
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  const result = await post('radarr', { eventType: 'Download', movie: { id: 'seven' } });
  expect(result).toEqual({ accepted: false, action: 'error', mediaFileIds: [], message: 'invalid webhook payload' });
});

test('webhook radarr - checkPath result maps to the webhook action', async () => {
  setup({ action: () => 'compatible' });
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  expect(await post('radarr', RADARR_DOWNLOAD)).toMatchObject({ accepted: true, action: 'compatible' });
});

test('webhook radarr - a throwing check is reported, not raised', async () => {
  setup({ action: () => new Error('disk gone') });
  insertArrInstance(t.ctx.db, { name: 'Radarr' });
  const result = await post('radarr', RADARR_DOWNLOAD);
  expect(result).toMatchObject({ accepted: false, action: 'error', mediaFileIds: [] });
  expect(result.message).toContain('disk gone');
});

test('webhook sonarr - every episode file is checked with its own file id', async () => {
  setup({ action: (path) => (path.endsWith('e2.mkv') ? 'dry_run' : 'compatible') });
  const instanceId = insertArrInstance(t.ctx.db, { kind: 'sonarr', name: 'Sonarr' });
  const result = await post('sonarr', {
    eventType: 'Download',
    isUpgrade: false,
    series: { id: 4, title: 'Show', path: '/tv/Show', originalLanguage: { id: 4, name: 'German' } },
    episodes: [{ id: 1, episodeNumber: 1, seasonNumber: 1 }],
    episodeFile: { id: 10, relativePath: 'Season 01/e1.mkv' },
    episodeFiles: [{ id: 11, relativePath: 'Season 01/e2.mkv' }],
  });
  expect(result).toMatchObject({ accepted: true, action: 'dry_run', mediaFileIds: [1, 2] });
  expect(calls.map((call) => [call.path, call.refs.arr?.fileId, call.refs.originalLanguage])).toEqual([
    ['/tv/Show/Season 01/e1.mkv', 10, 'ger'],
    ['/tv/Show/Season 01/e2.mkv', 11, 'ger'],
  ]);
  expect(calls[0]?.refs.arr).toEqual({ instanceId, kind: 'sonarr', itemId: 4, fileId: 10 });
});

test('webhook sonarr - Test event', async () => {
  setup();
  expect(await post('sonarr', { eventType: 'Test' })).toMatchObject({ action: 'test' });
});

test('webhook route - ?apikey= authenticates the arr apps', async () => {
  setup();
  const response = await t.app.request(`/api/v1/webhook/radarr?apikey=${TEST_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ eventType: 'Test' }),
  });
  expect(response.status).toBe(200);
  const denied = await t.app.request('/api/v1/webhook/radarr?apikey=wrong', {
    method: 'POST',
    body: JSON.stringify({ eventType: 'Test' }),
  });
  expect(denied.status).toBe(401);
});

test('webhook route - body without eventType is a validation error', async () => {
  setup();
  const response = await t.request('/api/v1/webhook/radarr', { method: 'POST', body: '{"movie":{}}' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'validation' });
});

test('webhook route - invalid instance query is a validation error', async () => {
  setup();
  const response = await t.request('/api/v1/webhook/sonarr?instance=abc', {
    method: 'POST',
    body: '{"eventType":"Test"}',
  });
  expect(response.status).toBe(400);
});
