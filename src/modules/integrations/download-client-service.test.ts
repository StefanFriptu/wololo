import { afterEach, beforeEach, expect, test } from 'bun:test';
import { linkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { BdmvService } from '../../contracts/bdmv.ts';
import { recycleBin } from '../../db/schema.ts';
import type { DownloadClientInput } from '../../shared/api-types.ts';
import type { BdmvDecision, TorrentInfo } from '../../shared/domain.ts';
import { type FakeUpstream, type RecordedRequest, startFakeUpstream } from './fake-upstream.ts';
import { SECRET_MASK } from './secrets.ts';

const SID = 'SID=session-1';

let t: TestContext;
let qbit: FakeUpstream;
let torrents: Record<string, unknown>[];
let offers: { mediaFileId: number; torrent: TorrentInfo }[];
let logins: number;

function authorised(request: RecordedRequest): boolean {
  return request.headers.get('cookie') === SID;
}

function decision(mediaFileId: number): BdmvDecision {
  return {
    id: 1,
    mediaFileId,
    kind: 'delete_source',
    state: 'pending',
    sourcePath: '',
    message: '',
    titleCandidates: [],
    movieCandidates: [],
    choice: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
  };
}

beforeEach(() => {
  torrents = [];
  offers = [];
  logins = 0;
  t = createTestContext({
    overrides: {
      bdmv: stubService<BdmvService>('bdmv', {
        offerSourceDeletion: async (mediaFileId, torrent) => {
          offers.push({ mediaFileId, torrent });
          return decision(mediaFileId);
        },
      }),
    },
  });
  qbit = startFakeUpstream({
    'POST /api/v2/auth/login': (request) => {
      logins += 1;
      const form = new URLSearchParams(request.body);
      if (form.get('username') !== 'admin' || form.get('password') !== 'secret') return new Response('Fails.');
      return new Response('Ok.', { headers: { 'Set-Cookie': `${SID}; HttpOnly; path=/` } });
    },
    'GET /api/v2/app/version': (request) =>
      authorised(request) ? new Response('v5.0.4') : new Response('', { status: 403 }),
    'GET /api/v2/torrents/info': (request) => (authorised(request) ? torrents : new Response('', { status: 403 })),
    'POST /api/v2/torrents/delete': (request) =>
      authorised(request) ? new Response('') : new Response('', { status: 403 }),
  });
});

afterEach(() => {
  qbit.stop();
  t.cleanup();
});

function input(overrides: Partial<DownloadClientInput> = {}): DownloadClientInput {
  return {
    kind: 'qbittorrent',
    enabled: true,
    url: qbit.url,
    username: 'admin',
    password: 'secret',
    removeWhenGoalMet: true,
    category: null,
    ...overrides,
  };
}

function torrent(hash: string, contentPath: string, overrides: Record<string, unknown> = {}) {
  return {
    hash,
    name: hash,
    save_path: '/downloads',
    content_path: contentPath,
    state: 'stalledUP',
    progress: 1,
    ratio: 2.5,
    seeding_time: 100,
    ratio_limit: -2,
    seeding_time_limit: -2,
    max_ratio: 2,
    max_seeding_time: -1,
    ...overrides,
  };
}

test('downloadClient.get - null until saved, password masked afterwards', async () => {
  expect(await t.ctx.services.downloadClient.get()).toBeNull();
  const saved = await t.ctx.services.downloadClient.save(input({ url: `${qbit.url}/` }));
  expect(saved).toEqual({ ...input(), password: SECRET_MASK });
  expect(await t.ctx.services.downloadClient.get()).toEqual(saved);
});

test('downloadClient.save - the mask keeps the stored password', async () => {
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.downloadClient.save(input({ password: SECRET_MASK, category: 'radarr' }));
  const result = await t.ctx.services.downloadClient.test(input({ password: SECRET_MASK }));
  expect(result).toEqual({ ok: true, message: 'Connected to qBittorrent v5.0.4', version: 'v5.0.4' });
});

test('downloadClient.remove - deletes the connection', async () => {
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.downloadClient.remove();
  expect(await t.ctx.services.downloadClient.get()).toBeNull();
});

test('downloadClient.test - wrong password is not ok and does not throw', async () => {
  const result = await t.ctx.services.downloadClient.test(input({ password: 'nope' }));
  expect(result).toEqual({ ok: false, message: 'qBittorrent rejected the username or password', version: null });
});

test('downloadClient.test - sends Referer and a form login', async () => {
  await t.ctx.services.downloadClient.test(input());
  const login = qbit.requestsTo('POST /api/v2/auth/login')[0];
  expect(login?.headers.get('referer')).toBe(qbit.url);
  expect(login?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
});

test('downloadClient.findTorrentByPath - null when not configured or disabled', async () => {
  expect(await t.ctx.services.downloadClient.findTorrentByPath('/data/x')).toBeNull();
  await t.ctx.services.downloadClient.save(input({ enabled: false }));
  expect(await t.ctx.services.downloadClient.findTorrentByPath('/data/x')).toBeNull();
  expect(qbit.requests).toHaveLength(0);
});

test('downloadClient.findTorrentByPath - maps paths both ways and filters by category', async () => {
  await t.ctx.services.downloadClient.save(input({ category: 'radarr' }));
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: '/data/dl' });
  torrents = [torrent('aaa', '/downloads/Heat'), torrent('bbb', '/downloads/Other')];
  const found = await t.ctx.services.downloadClient.findTorrentByPath('/data/dl/Heat/BDMV');
  expect(found).toMatchObject({ hash: 'aaa', contentPath: '/data/dl/Heat', savePath: '/data/dl', goalMet: true });
  expect(qbit.requestsTo('GET /api/v2/torrents/info')[0]?.query.get('category')).toBe('radarr');
});

test('downloadClient - an expired session logs in again once', async () => {
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.downloadClient.findTorrentByPath('/x');
  let expired = true;
  qbit.on('GET /api/v2/torrents/info', (request) => {
    if (expired) {
      expired = false;
      return new Response('', { status: 403 });
    }
    return authorised(request) ? torrents : new Response('', { status: 403 });
  });
  await t.ctx.services.downloadClient.findTorrentByPath('/x');
  expect(logins).toBe(2);
});

test('downloadClient.deleteTorrent - posts hashes and deleteFiles', async () => {
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.downloadClient.deleteTorrent('abc', true);
  const form = new URLSearchParams(qbit.requestsTo('POST /api/v2/torrents/delete')[0]?.body);
  expect(form.get('hashes')).toBe('abc');
  expect(form.get('deleteFiles')).toBe('true');
});

test('downloadClient.deleteTorrent - without a client is a precondition failure', async () => {
  await expect(t.ctx.services.downloadClient.deleteTorrent('abc', false)).rejects.toMatchObject({
    code: 'precondition_failed',
  });
});

test('downloadClient.checkSeedingGoals - nothing configured', async () => {
  expect(await t.ctx.services.downloadClient.checkSeedingGoals()).toBe('no download client configured');
});

interface SeedingFixture {
  downloads: string;
  library: string;
}

function seedingFixture(): SeedingFixture {
  const downloads = join(t.dir, 'downloads');
  const library = join(t.dir, 'library');
  mkdirSync(join(downloads, 'Replaced'), { recursive: true });
  mkdirSync(join(downloads, 'Untouched'), { recursive: true });
  mkdirSync(join(downloads, 'InLibrary'), { recursive: true });
  mkdirSync(join(downloads, 'Disc', 'BDMV'), { recursive: true });
  mkdirSync(join(library, '.wololo-recycle'), { recursive: true });
  writeFileSync(join(downloads, 'Replaced', 'movie.mkv'), 'original');
  writeFileSync(join(downloads, 'Untouched', 'movie.mkv'), 'still linked');
  writeFileSync(join(downloads, 'InLibrary', 'movie.mkv'), 'library lives here');
  return { downloads, library };
}

function recycle(originalPath: string, recyclePath: string, jobState: 'completed' | 'failed' = 'completed') {
  const job = insertJob(t.ctx.db, { sourcePath: originalPath, type: 'audio', state: jobState });
  t.ctx.db
    .insert(recycleBin)
    .values({ originalPath, recyclePath, sizeBytes: 1, jobId: job.id, expiresAt: '2999-01-01T00:00:00.000Z' })
    .run();
}

test('downloadClient.checkSeedingGoals - removes only torrents holding a replaced original', async () => {
  const { downloads, library } = seedingFixture();
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: downloads });
  const binCopy = join(library, '.wololo-recycle', 'movie.mkv');
  linkSync(join(downloads, 'Replaced', 'movie.mkv'), binCopy);
  recycle(join(library, 'Movie (2020)', 'Movie.mkv'), binCopy);
  const inLibraryBin = join(library, '.wololo-recycle', 'in-library.mkv');
  linkSync(join(downloads, 'InLibrary', 'movie.mkv'), inLibraryBin);
  recycle(join(downloads, 'InLibrary', 'movie.mkv'), inLibraryBin);
  const lib = insertLibrary(t.ctx.db, { roots: [downloads] });
  insertMediaFile(t.ctx.db, lib, { path: join(downloads, 'InLibrary', 'movie.mkv') });
  torrents = [
    torrent('replaced', '/downloads/Replaced'),
    torrent('untouched', '/downloads/Untouched'),
    torrent('inlibrary', '/downloads/InLibrary'),
    torrent('still-seeding', '/downloads/Replaced', { ratio: 1 }),
  ];

  const summary = await t.ctx.services.downloadClient.checkSeedingGoals();

  expect(summary).toBe('3 torrent(s) met their seeding goal: 1 removed, 0 source deletion(s) offered');
  const deleted = qbit.requestsTo('POST /api/v2/torrents/delete').map((request) => new URLSearchParams(request.body));
  expect(deleted.map((form) => [form.get('hashes'), form.get('deleteFiles')])).toEqual([['replaced', 'true']]);
});

test('downloadClient.checkSeedingGoals - a restored or unfinished replacement keeps the torrent', async () => {
  const { downloads, library } = seedingFixture();
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: downloads });
  const binCopy = join(library, '.wololo-recycle', 'movie.mkv');
  linkSync(join(downloads, 'Replaced', 'movie.mkv'), binCopy);
  recycle('/library/Movie.mkv', binCopy, 'failed');
  torrents = [torrent('replaced', '/downloads/Replaced')];
  expect(await t.ctx.services.downloadClient.checkSeedingGoals()).toContain('0 removed');
  expect(qbit.requestsTo('POST /api/v2/torrents/delete')).toHaveLength(0);
});

test('downloadClient.checkSeedingGoals - removeWhenGoalMet off never deletes', async () => {
  const { downloads, library } = seedingFixture();
  await t.ctx.services.downloadClient.save(input({ removeWhenGoalMet: false }));
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: downloads });
  const binCopy = join(library, '.wololo-recycle', 'movie.mkv');
  linkSync(join(downloads, 'Replaced', 'movie.mkv'), binCopy);
  recycle('/library/Movie.mkv', binCopy);
  torrents = [torrent('replaced', '/downloads/Replaced')];
  await t.ctx.services.downloadClient.checkSeedingGoals();
  expect(qbit.requestsTo('POST /api/v2/torrents/delete')).toHaveLength(0);
});

test('downloadClient.checkSeedingGoals - offers deletion of converted discs when enabled', async () => {
  const { downloads } = seedingFixture();
  t.ctx.settings.update({ bdmv: { deleteSourceWhenSeeded: true } });
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: downloads });
  const lib = insertLibrary(t.ctx.db, { roots: [downloads] });
  const disc = insertMediaFile(t.ctx.db, lib, { path: join(downloads, 'Disc'), kind: 'bdmv' });
  const pending = insertMediaFile(t.ctx.db, lib, { path: join(downloads, 'Disc2'), kind: 'bdmv' });
  insertJob(t.ctx.db, { sourcePath: disc.path, type: 'bdmv', state: 'completed', mediaFileId: disc.id });
  insertJob(t.ctx.db, { sourcePath: pending.path, type: 'bdmv', state: 'failed', mediaFileId: pending.id });
  torrents = [torrent('disc', '/downloads/Disc'), torrent('disc2', '/downloads/Disc2')];

  const summary = await t.ctx.services.downloadClient.checkSeedingGoals();

  expect(summary).toBe('2 torrent(s) met their seeding goal: 0 removed, 1 source deletion(s) offered');
  expect(offers).toHaveLength(1);
  expect(offers[0]?.mediaFileId).toBe(disc.id);
  expect(offers[0]?.torrent).toMatchObject({ hash: 'disc', contentPath: join(downloads, 'Disc'), goalMet: true });
  expect(qbit.requestsTo('POST /api/v2/torrents/delete')).toHaveLength(0);
});

test('downloadClient.checkSeedingGoals - disc offers stay off by default', async () => {
  const { downloads } = seedingFixture();
  await t.ctx.services.downloadClient.save(input());
  await t.ctx.services.pathMappings.create({ scope: 'qbittorrent', remotePath: '/downloads', localPath: downloads });
  const lib = insertLibrary(t.ctx.db, { roots: [downloads] });
  const disc = insertMediaFile(t.ctx.db, lib, { path: join(downloads, 'Disc'), kind: 'bdmv' });
  insertJob(t.ctx.db, { sourcePath: disc.path, type: 'bdmv', state: 'completed', mediaFileId: disc.id });
  torrents = [torrent('disc', '/downloads/Disc')];
  await t.ctx.services.downloadClient.checkSeedingGoals();
  expect(offers).toHaveLength(0);
});

test('downloadClient routes - save, read, test and delete', async () => {
  const saved = await t.request('/api/v1/downloadclient', { method: 'PUT', body: JSON.stringify({ url: qbit.url }) });
  expect(await saved.json()).toEqual({
    kind: 'qbittorrent',
    enabled: true,
    url: qbit.url,
    username: '',
    password: '',
    removeWhenGoalMet: false,
    category: null,
  });
  const tested = await t.request('/api/v1/downloadclient/test', {
    method: 'POST',
    body: JSON.stringify({ url: qbit.url, username: 'admin', password: 'secret' }),
  });
  expect(await tested.json()).toMatchObject({ ok: true });
  expect((await t.request('/api/v1/downloadclient', { method: 'DELETE' })).status).toBe(204);
  expect(await (await t.request('/api/v1/downloadclient')).json()).toBeNull();
  expect((await t.request('/api/v1/downloadclient', { method: 'PUT', body: '{"url":"nope"}' })).status).toBe(400);
});
