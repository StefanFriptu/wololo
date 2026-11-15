import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import type { ArrInstance } from '../../shared/domain.ts';
import { createArrService } from './arr-service.ts';
import { type FakeUpstream, startFakeUpstream } from './fake-upstream.ts';
import { SECRET_MASK } from './secrets.ts';

const API_KEY = 'radarr-key-0123456789';

let t: TestContext;
let radarr: FakeUpstream;
let sonarr: FakeUpstream;

beforeEach(() => {
  t = createTestContext();
  radarr = startFakeUpstream({
    'GET /api/v3/system/status': () => ({ appName: 'Radarr', version: '5.20.0' }),
    'GET /api/v3/rootfolder': () => [{ id: 1, path: '/vault/movies', accessible: true, freeSpace: 1000 }],
    'GET /api/v3/qualityprofile': () => [
      { id: 4, name: 'HD-1080p' },
      { id: 6, name: 'Ultra-HD' },
    ],
    'GET /api/v3/movie': () => [
      {
        id: 11,
        title: 'Heat',
        path: '/vault/movies/Heat (1995)',
        tmdbId: 949,
        originalLanguage: { id: 1, name: 'English' },
        movieFile: { id: 21, path: '/vault/movies/Heat (1995)/Heat.mkv' },
      },
      {
        id: 12,
        title: 'Jamon Jamon',
        path: '/vault/movies/Jamon Jamon (1992)',
        tmdbId: 3576,
        originalLanguage: { id: 3, name: 'Spanish' },
      },
    ],
    'GET /api/v3/movie/lookup': () => [
      { title: 'Golden Balls', year: 1993, tmdbId: 1 },
      { title: 'Jamón, jamón', originalTitle: 'Jamón, jamón', year: 1992, tmdbId: 3576, imdbId: 'tt0104545' },
      { title: 'Broken', year: 2000, tmdbId: 0 },
    ],
    'GET /api/v3/movie/lookup/tmdb': () => ({ id: 0, title: 'Heat', year: 1995, tmdbId: 949 }),
    'POST /api/v3/movie': () => ({ id: 99, title: 'New' }),
    'POST /api/v3/command': () => ({ id: 1, name: 'x', status: 'queued' }),
  });
  sonarr = startFakeUpstream({
    'GET /api/v3/system/status': () => ({ appName: 'Sonarr', version: '4.0.14' }),
    'GET /api/v3/series': () => [
      { id: 5, title: 'Show', path: '/vault/tv/Show', originalLanguage: { id: 4, name: 'German' } },
    ],
    'GET /api/v3/episodefile': () => [
      { id: 50, path: '/vault/tv/Show/Season 01/e1.mkv' },
      { id: 51, path: '/vault/tv/Show/Season 01/e2.mkv' },
    ],
    'POST /api/v3/command': () => ({ id: 2 }),
  });
});

afterEach(() => {
  radarr.stop();
  sonarr.stop();
  t.cleanup();
});

async function addRadarr(overrides: Partial<{ name: string; url: string; enabled: boolean }> = {}) {
  return t.ctx.services.arr.create({ kind: 'radarr', name: 'Radarr', url: radarr.url, apiKey: API_KEY, ...overrides });
}

async function addSonarr(): Promise<ArrInstance> {
  return t.ctx.services.arr.create({ kind: 'sonarr', name: 'Sonarr', url: sonarr.url, apiKey: 'sonarr-key' });
}

async function mapRadarr(instanceId: number | null = null) {
  await t.ctx.services.pathMappings.create({
    scope: 'radarr',
    instanceId,
    remotePath: '/vault/movies',
    localPath: '/data/movies',
  });
}

function jsonBody(upstream: FakeUpstream, key: string): unknown[] {
  return upstream.requestsTo(key).map((request) => JSON.parse(request.body));
}

test('arr.create - masks the API key and trims the url', async () => {
  const created = await addRadarr({ url: `${radarr.url}/` });
  expect(created.apiKey).toBe(SECRET_MASK);
  expect(created.url).toBe(radarr.url);
  expect(created.enabled).toBe(true);
  expect((await t.ctx.services.arr.list()).map((instance) => instance.apiKey)).toEqual([SECRET_MASK]);
});

test('arr.create - duplicate name is a conflict', async () => {
  await addRadarr();
  await expect(addRadarr()).rejects.toMatchObject({ code: 'conflict' });
});

test('arr.create - the mask is not a valid new key', async () => {
  const create = t.ctx.services.arr.create({ kind: 'radarr', name: 'y', url: radarr.url, apiKey: SECRET_MASK });
  await expect(create).rejects.toMatchObject({ code: 'validation' });
});

test('arr.update - the mask keeps the stored key', async () => {
  const created = await addRadarr();
  await t.ctx.services.arr.update(created.id, {
    kind: 'radarr',
    name: 'Radarr HD',
    url: radarr.url,
    apiKey: SECRET_MASK,
    enabled: false,
  });
  const updated = await t.ctx.services.arr.get(created.id);
  expect(updated).toMatchObject({ name: 'Radarr HD', enabled: false });
  await t.ctx.services.arr.rootFolders(created.id);
  expect(radarr.requests.at(-1)?.headers.get('x-api-key')).toBe(API_KEY);
});

test('arr.update - the mask with a new URL is refused and keeps the stored instance', async () => {
  const created = await addRadarr();
  const evil = startFakeUpstream();
  try {
    const update = t.ctx.services.arr.update(created.id, {
      kind: 'radarr',
      name: 'Radarr',
      url: evil.url,
      apiKey: SECRET_MASK,
    });
    await expect(update).rejects.toMatchObject({ code: 'unprocessable', message: expect.stringContaining('API key') });
    expect((await t.ctx.services.arr.get(created.id)).url).toBe(radarr.url);
  } finally {
    evil.stop();
  }
});

test('arr.update - a new URL with a new key is accepted', async () => {
  const created = await addRadarr();
  const updated = await t.ctx.services.arr.update(created.id, {
    kind: 'radarr',
    name: 'Radarr',
    url: `${radarr.url}/`,
    apiKey: SECRET_MASK,
  });
  expect(updated.url).toBe(radarr.url);
  const moved = await t.ctx.services.arr.update(created.id, {
    kind: 'radarr',
    name: 'Radarr',
    url: sonarr.url,
    apiKey: 'other-key',
  });
  expect(moved.url).toBe(sonarr.url);
});

test('arr.update - kind cannot change', async () => {
  const created = await addRadarr();
  await expect(
    t.ctx.services.arr.update(created.id, { kind: 'sonarr', name: 'Radarr', url: radarr.url, apiKey: API_KEY }),
  ).rejects.toMatchObject({ code: 'unprocessable' });
});

test('arr.get - unknown id is not found', async () => {
  await expect(t.ctx.services.arr.get(404)).rejects.toMatchObject({ code: 'not_found' });
});

test('arr.remove - deletes the instance and its path mappings', async () => {
  const created = await addRadarr();
  await mapRadarr(created.id);
  await t.ctx.services.arr.remove(created.id);
  expect(await t.ctx.services.arr.list()).toEqual([]);
  expect(await t.ctx.services.pathMappings.list()).toEqual([]);
  await expect(t.ctx.services.arr.remove(created.id)).rejects.toMatchObject({ code: 'not_found' });
});

test('arr.test - reports the version and sends the key', async () => {
  const result = await t.ctx.services.arr.test({ kind: 'radarr', name: 'x', url: radarr.url, apiKey: API_KEY });
  expect(result).toEqual({ ok: true, message: 'Connected to Radarr 5.20.0', version: '5.20.0' });
  expect(radarr.requestsTo('GET /api/v3/system/status')[0]?.headers.get('x-api-key')).toBe(API_KEY);
});

test('arr.test - masked key resolves through the stored instance', async () => {
  const created = await addRadarr();
  const result = await t.ctx.services.arr.test({
    id: created.id,
    kind: 'radarr',
    name: 'Radarr',
    url: radarr.url,
    apiKey: SECRET_MASK,
  });
  expect(result.ok).toBe(true);
  expect(radarr.requests.at(-1)?.headers.get('x-api-key')).toBe(API_KEY);
});

test('arr.test - the mask is never sent to a different URL', async () => {
  const created = await addRadarr();
  const evil = startFakeUpstream({ 'GET /api/v3/system/status': () => ({ appName: 'Radarr', version: '1' }) });
  try {
    const result = await t.ctx.services.arr.test({
      id: created.id,
      kind: 'radarr',
      name: 'Radarr',
      url: evil.url,
      apiKey: SECRET_MASK,
    });
    expect(result).toEqual({ ok: false, message: 'the URL changed, so enter the API key again', version: null });
    expect(evil.requests).toHaveLength(0);
  } finally {
    evil.stop();
  }
});

test('arr.test - a redirect is refused and the key is not forwarded', async () => {
  const target = startFakeUpstream({ 'GET /api/v3/system/status': () => ({ appName: 'Radarr', version: '1' }) });
  radarr.on(
    'GET /api/v3/system/status',
    () => new Response(null, { status: 302, headers: { Location: `${target.url}/api/v3/system/status` } }),
  );
  try {
    const result = await t.ctx.services.arr.test({ kind: 'radarr', name: 'x', url: radarr.url, apiKey: API_KEY });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`redirected to ${new URL(target.url).host}`);
    expect(target.requests).toHaveLength(0);
  } finally {
    target.stop();
  }
});

test('arr.rootFolders - a body that stalls after the headers is an upstream timeout', async () => {
  const stalled = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"id":1,'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  try {
    const service = createArrService(t.ctx, { timeoutMs: 200 });
    const created = await addRadarr({ url: `http://127.0.0.1:${stalled.port}` });
    const failure = service.rootFolders(created.id);
    await expect(failure).rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('timed out') });
  } finally {
    stalled.stop(true);
  }
});

test('arr.test - wrong application is not ok', async () => {
  const result = await t.ctx.services.arr.test({ kind: 'radarr', name: 'x', url: sonarr.url, apiKey: 'k' });
  expect(result).toMatchObject({ ok: false, message: 'this is Sonarr, not Radarr' });
});

test('arr.test - rejected key is not ok and does not throw', async () => {
  radarr.on('GET /api/v3/system/status', () => new Response('unauthorized', { status: 401 }));
  const result = await t.ctx.services.arr.test({ kind: 'radarr', name: 'x', url: radarr.url, apiKey: 'bad' });
  expect(result.ok).toBe(false);
  expect(result.message).toContain('HTTP 401');
  expect(result.message).not.toContain('bad');
});

test('arr.test - unreachable server is not ok', async () => {
  const result = await t.ctx.services.arr.test({ kind: 'radarr', name: 'x', url: 'http://127.0.0.1:1', apiKey: 'k' });
  expect(result.ok).toBe(false);
  expect(result.message).toContain('unreachable');
});

test('arr.test - a slow server times out', async () => {
  const slow = startFakeUpstream({
    'GET /api/v3/system/status': async () => {
      await Bun.sleep(300);
      return { appName: 'Radarr', version: '1' };
    },
  });
  try {
    const service = createArrService(t.ctx, { timeoutMs: 50 });
    const result = await service.test({ kind: 'radarr', name: 'x', url: slow.url, apiKey: 'k' });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('timed out') });
  } finally {
    slow.stop();
  }
});

test('arr.rootFolders - maps remote paths and checks local access', async () => {
  const created = await addRadarr();
  const local = join(t.dir, 'movies');
  mkdirSync(local);
  await t.ctx.services.pathMappings.create({ scope: 'radarr', remotePath: '/vault/movies', localPath: local });
  expect(await t.ctx.services.arr.rootFolders(created.id)).toEqual([
    { id: 1, path: '/vault/movies', localPath: local, accessible: true, freeBytes: 1000 },
  ]);
});

test('arr.rootFolders - upstream failure throws upstream', async () => {
  const created = await addRadarr();
  radarr.on('GET /api/v3/rootfolder', () => new Response('boom', { status: 500 }));
  await expect(t.ctx.services.arr.rootFolders(created.id)).rejects.toMatchObject({ code: 'upstream' });
});

test('arr.rootFolders - unexpected response shape throws upstream', async () => {
  const created = await addRadarr();
  radarr.on('GET /api/v3/rootfolder', () => ({ not: 'a list' }));
  await expect(t.ctx.services.arr.rootFolders(created.id)).rejects.toMatchObject({ code: 'upstream' });
});

test('arr.qualityProfiles - lists id and name', async () => {
  const created = await addRadarr();
  expect(await t.ctx.services.arr.qualityProfiles(created.id)).toEqual([
    { id: 4, name: 'HD-1080p' },
    { id: 6, name: 'Ultra-HD' },
  ]);
});

test('arr.lookupMovie - scores locally, sorts, drops invalid ids and finds library movies', async () => {
  const created = await addRadarr();
  const results = await t.ctx.services.arr.lookupMovie(created.id, 'Jamon Jamon', 1992);
  expect(results.map((movie) => movie.tmdbId)).toEqual([3576, 1]);
  expect(results[0]).toEqual({
    title: 'Jamón, jamón',
    year: 1992,
    tmdbId: 3576,
    imdbId: 'tt0104545',
    score: 1,
    radarrMovieId: 12,
  });
  expect(results[1]?.radarrMovieId).toBeNull();
  expect(radarr.requestsTo('GET /api/v3/movie/lookup')[0]?.query.get('term')).toBe('Jamon Jamon (1992)');
});

test('arr.lookupMovie - tmdb: term resolves one id with score 1', async () => {
  const created = await addRadarr();
  const results = await t.ctx.services.arr.lookupMovie(created.id, 'tmdb:949');
  expect(results).toEqual([{ title: 'Heat', year: 1995, tmdbId: 949, imdbId: null, score: 1, radarrMovieId: 11 }]);
  expect(radarr.requestsTo('GET /api/v3/movie/lookup/tmdb')[0]?.query.get('tmdbId')).toBe('949');
});

test('arr.lookupMovie - a Sonarr instance is rejected', async () => {
  const created = await addSonarr();
  await expect(t.ctx.services.arr.lookupMovie(created.id, 'x')).rejects.toMatchObject({ code: 'unprocessable' });
});

test('arr.addMovie - translates the root folder and uses the first quality profile', async () => {
  const created = await addRadarr();
  await mapRadarr();
  const id = await t.ctx.services.arr.addMovie(created.id, {
    tmdbId: 3576,
    title: 'Jamon Jamon',
    year: 1992,
    rootFolderPath: '/data/movies',
    qualityProfileId: null,
  });
  expect(id).toBe(99);
  expect(jsonBody(radarr, 'POST /api/v3/movie')).toEqual([
    {
      title: 'Jamon Jamon',
      tmdbId: 3576,
      year: 1992,
      qualityProfileId: 4,
      rootFolderPath: '/vault/movies',
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false },
    },
  ]);
});

test('arr.findByPath - Radarr movie with file id and normalised language', async () => {
  const created = await addRadarr();
  await mapRadarr();
  expect(await t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv')).toEqual({
    ref: { instanceId: created.id, kind: 'radarr', itemId: 11, fileId: 21 },
    originalLanguage: 'eng',
  });
});

test('arr.findByPath - a disc folder inside the movie folder has no file id', async () => {
  const created = await addRadarr();
  await mapRadarr();
  expect(await t.ctx.services.arr.findByPath('/data/movies/Jamon Jamon (1992)/DISC')).toEqual({
    ref: { instanceId: created.id, kind: 'radarr', itemId: 12, fileId: null },
    originalLanguage: 'spa',
  });
});

test('arr.findByPath - Sonarr series with episode file id', async () => {
  const created = await addSonarr();
  await t.ctx.services.pathMappings.create({ scope: 'sonarr', remotePath: '/vault/tv', localPath: '/data/tv' });
  expect(await t.ctx.services.arr.findByPath('/data/tv/Show/Season 01/e2.mkv')).toEqual({
    ref: { instanceId: created.id, kind: 'sonarr', itemId: 5, fileId: 51 },
    originalLanguage: 'ger',
  });
  expect(sonarr.requestsTo('GET /api/v3/episodefile')[0]?.query.get('seriesId')).toBe('5');
});

test('arr.findByPath - unknown path is null, a failing instance is skipped', async () => {
  await addRadarr();
  await addSonarr();
  sonarr.on('GET /api/v3/series', () => new Response('down', { status: 503 }));
  expect(await t.ctx.services.arr.findByPath('/elsewhere/a.mkv')).toBeNull();
});

test('arr.findByPath - caches the library index between calls', async () => {
  await addRadarr();
  await mapRadarr();
  await t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv');
  await t.ctx.services.arr.findByPath('/data/movies/Jamon Jamon (1992)/a.mkv');
  expect(radarr.requestsTo('GET /api/v3/movie')).toHaveLength(1);
});

test('arr.findByPath - concurrent lookups share one library download', async () => {
  await addRadarr();
  await mapRadarr();
  const found = await Promise.all([
    t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv'),
    t.ctx.services.arr.findByPath('/data/movies/Jamon Jamon (1992)/a.mkv'),
    t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv'),
  ]);
  expect(found.map((result) => result?.ref.itemId)).toEqual([11, 12, 11]);
  expect(radarr.requestsTo('GET /api/v3/movie')).toHaveLength(1);
});

test('arr.findByPath - a failed build is not cached', async () => {
  await addRadarr();
  await mapRadarr();
  radarr.on('GET /api/v3/movie', () => new Response('down', { status: 503 }));
  expect(await t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv')).toBeNull();
  radarr.on('GET /api/v3/movie', () => [{ id: 11, title: 'Heat', path: '/vault/movies/Heat (1995)' }]);
  expect((await t.ctx.services.arr.findByPath('/data/movies/Heat (1995)/Heat.mkv'))?.ref.itemId).toBe(11);
});

test('arr.findByPath - a miss refreshes a stale index once', async () => {
  let clock = 0;
  const service = createArrService(t.ctx, { now: () => clock });
  await addRadarr();
  await mapRadarr();
  await service.findByPath('/data/movies/Heat (1995)/Heat.mkv');
  clock = 60_000;
  expect(await service.findByPath('/data/movies/New (2026)/n.mkv')).toBeNull();
  expect(radarr.requestsTo('GET /api/v3/movie')).toHaveLength(2);
});

test('arr.findByPath - disabled instances are not asked', async () => {
  await addRadarr({ enabled: false });
  expect(await t.ctx.services.arr.findByPath('/vault/movies/Heat (1995)/Heat.mkv')).toBeNull();
  expect(radarr.requests).toHaveLength(0);
});

test('arr.rescan - RescanMovie and RescanSeries commands', async () => {
  const movies = await addRadarr();
  const shows = await addSonarr();
  await t.ctx.services.arr.rescan({ instanceId: movies.id, kind: 'radarr', itemId: 11, fileId: null });
  await t.ctx.services.arr.rescan({ instanceId: shows.id, kind: 'sonarr', itemId: 5, fileId: 50 });
  expect(jsonBody(radarr, 'POST /api/v3/command')).toEqual([{ name: 'RescanMovie', movieId: 11 }]);
  expect(jsonBody(sonarr, 'POST /api/v3/command')).toEqual([{ name: 'RescanSeries', seriesId: 5 }]);
  expect(sonarr.requestsTo('POST /api/v3/command')[0]?.headers.get('content-type')).toBe('application/json');
});

test('arr.rescan - kind mismatch is unprocessable', async () => {
  const movies = await addRadarr();
  await expect(
    t.ctx.services.arr.rescan({ instanceId: movies.id, kind: 'sonarr', itemId: 1, fileId: null }),
  ).rejects.toMatchObject({ code: 'unprocessable' });
});

test('arr.importMovieFolder - DownloadedMoviesScan with the remote path', async () => {
  const created = await addRadarr();
  await mapRadarr();
  await t.ctx.services.arr.importMovieFolder(created.id, '/data/movies/Jamon Jamon (1992)');
  expect(jsonBody(radarr, 'POST /api/v3/command')).toEqual([
    { name: 'DownloadedMoviesScan', path: '/vault/movies/Jamon Jamon (1992)' },
  ]);
});

test('arr.defaultRadarr - first enabled Radarr instance, masked', async () => {
  expect(await t.ctx.services.arr.defaultRadarr()).toBeNull();
  await addSonarr();
  await addRadarr({ name: 'Off', enabled: false });
  const second = await addRadarr({ name: 'On' });
  expect(await t.ctx.services.arr.defaultRadarr()).toMatchObject({ id: second.id, apiKey: SECRET_MASK });
});
