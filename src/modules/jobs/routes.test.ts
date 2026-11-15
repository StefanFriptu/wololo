import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import { routesOf, splitRouteKey } from '../../shared/api-routes.ts';
import type { EnqueueResponse } from '../../shared/api-types.ts';
import { getJobRow, updateJobRow } from './jobQueries.ts';
import { mediaDetail, recordingMediaService } from './test-support.ts';

let t: TestContext | null = null;
afterEach(async () => {
  await t?.ctx.services.jobs.stop();
  t?.cleanup();
  t = null;
});

function setup(processing = true) {
  const { service, recorder } = recordingMediaService([]);
  t = createTestContext({
    settings: { processing: { enabled: processing } },
    overrides: {
      media: service,
      libraries: stubService<LibraryService>('libraries', { findRootForPath: async () => null }),
    },
  });
  const library = insertLibrary(t.ctx.db, { roots: [join(t.dir, 'movies')] });
  const media = insertMediaFile(t.ctx.db, library, { path: join(t.dir, 'movies', 'A', 'A.mkv') });
  recorder.files.set(media.id, mediaDetail(media.id, media.path, { libraryId: library.libraryId }));
  return { t, mediaFileId: media.id };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('routes - no jobs or recycle-bin route answers 501 any more', async () => {
  const { t } = setup();
  for (const key of routesOf('jobs')) {
    const { method, path } = splitRouteKey(key);
    const response = await t.request(path.replace(':id', '999'), {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    });
    expect({ key, status: response.status }).not.toEqual({ key, status: 501 });
  }
});

test('GET /api/v1/queue and pause/resume - report the queue state', async () => {
  const { t } = setup();
  const queue = await t.request('/api/v1/queue');
  expect(queue.status).toBe(200);
  expect(await queue.json()).toEqual({
    state: { paused: false, pauseReasons: [], running: 0, queued: 0, concurrency: 1 },
    items: [],
  });
  const paused = await t.request('/api/v1/queue/pause', { method: 'POST' });
  expect(await paused.json()).toMatchObject({ paused: true, pauseReasons: ['user'] });
  const resumed = await t.request('/api/v1/queue/resume', { method: 'POST' });
  expect(await resumed.json()).toMatchObject({ paused: false, pauseReasons: [] });
});

test('POST /api/v1/jobs - validates the body and queues by id', async () => {
  const { t, mediaFileId } = setup();
  t.ctx.services.jobs.pause('user');

  expect((await t.request('/api/v1/jobs', json({}))).status).toBe(400);
  expect((await t.request('/api/v1/jobs', json({ mediaFileIds: [1], filter: {} }))).status).toBe(400);
  expect((await t.request('/api/v1/jobs', json({ mediaFileIds: ['x'] }))).status).toBe(400);
  const response = await t.request('/api/v1/jobs', json({ mediaFileIds: [mediaFileId], priority: 2 }));

  expect(response.status).toBe(200);
  const body = (await response.json()) as EnqueueResponse;
  expect(body.skipped).toEqual([]);
  expect(body.jobs[0]).toMatchObject({ mediaFileId, type: 'audio', state: 'queued', priority: 2 });
});

test('POST /api/v1/jobs - 412 while processing is off', async () => {
  const { t, mediaFileId } = setup(false);
  const response = await t.request('/api/v1/jobs', json({ mediaFileIds: [mediaFileId] }));
  expect(response.status).toBe(412);
  expect(await response.json()).toMatchObject({ error: 'precondition_failed' });
});

test('GET /api/v1/jobs - validates the query and paginates', async () => {
  const { t } = setup();
  insertJob(t.ctx.db, { sourcePath: '/a.mkv', state: 'failed' });
  insertJob(t.ctx.db, { sourcePath: '/b.mkv', state: 'completed' });

  expect((await t.request('/api/v1/jobs?state=bogus')).status).toBe(400);
  expect((await t.request('/api/v1/jobs?pageSize=0')).status).toBe(400);
  const response = await t.request('/api/v1/jobs?state=failed,completed&pageSize=1&sortDir=asc');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ page: 1, pageSize: 1, total: 2, items: [{ sourcePath: '/a.mkv' }] });
});

test('GET /api/v1/jobs/:id and /log - detail, 404s and the plain-text log', async () => {
  const { t } = setup();
  const row = insertJob(t.ctx.db, { sourcePath: '/a.mkv', state: 'completed' });

  expect((await t.request('/api/v1/jobs/abc')).status).toBe(400);
  expect((await t.request('/api/v1/jobs/999')).status).toBe(404);
  const detail = await t.request(`/api/v1/jobs/${row.id}`);
  expect(await detail.json()).toMatchObject({ id: row.id, hasLog: false, plan: null, verification: null });
  expect((await t.request(`/api/v1/jobs/${row.id}/log`)).status).toBe(404);

  const logPath = join(t.ctx.config.get().jobLogDir, `${row.id}.txt`);
  mkdirSync(t.ctx.config.get().jobLogDir, { recursive: true });
  writeFileSync(logPath, 'line one\nline two\n');
  updateJobRow(t.ctx.db, row.id, { logPath });
  const log = await t.request(`/api/v1/jobs/${row.id}/log`);
  expect(log.status).toBe(200);
  expect(log.headers.get('content-type')).toContain('text/plain');
  expect(await log.text()).toBe('line one\nline two\n');
});

test('job actions - cancel, retry and delete answer with the right status codes', async () => {
  const { t } = setup();
  const row = insertJob(t.ctx.db, { sourcePath: '/a.mkv', state: 'queued' });

  expect((await t.request(`/api/v1/jobs/${row.id}`, { method: 'DELETE' })).status).toBe(409);
  const cancelled = await t.request(`/api/v1/jobs/${row.id}/cancel`, { method: 'POST' });
  expect(await cancelled.json()).toMatchObject({ state: 'cancelled' });
  expect((await t.request(`/api/v1/jobs/${row.id}/cancel`, { method: 'POST' })).status).toBe(409);
  t.ctx.services.jobs.pause('user');
  const retried = await t.request(`/api/v1/jobs/${row.id}/retry`, { method: 'POST' });
  expect(await retried.json()).toMatchObject({ state: 'queued', trigger: 'retry' });
  await t.request(`/api/v1/jobs/${row.id}/cancel`, { method: 'POST' });
  const deleted = await t.request(`/api/v1/jobs/${row.id}`, { method: 'DELETE' });
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  expect(getJobRow(t.ctx.db, row.id)).toBeUndefined();
});

test('GET /api/v1/history - filters by event and rejects unknown events', async () => {
  const { t } = setup();
  await t.ctx.services.jobs.addHistory({ event: 'purged', path: '/a', message: 'gone' });
  expect((await t.request('/api/v1/history?event=nope')).status).toBe(400);
  const response = await t.request('/api/v1/history?event=purged');
  expect(await response.json()).toMatchObject({ total: 1, items: [{ event: 'purged', path: '/a' }] });
});

test('recycle bin routes - list, purge, restore and delete', async () => {
  const { t } = setup();
  const file = join(t.dir, 'movies', 'B', 'B.mkv');
  mkdirSync(join(t.dir, 'movies', 'B'), { recursive: true });
  writeFileSync(file, 'original');
  const entry = await t.ctx.services.recycleBin.recycle(file, {});

  const list = await t.request('/api/v1/recyclebin?pageSize=10');
  expect(await list.json()).toMatchObject({ total: 1, items: [{ id: entry.id, originalPath: file }] });
  expect((await t.request('/api/v1/recyclebin/purge', json({ all: 'yes' }))).status).toBe(400);
  expect(await (await t.request('/api/v1/recyclebin/purge', json({}))).json()).toEqual({ purged: 0, freedBytes: 0 });
  expect((await t.request('/api/v1/recyclebin/999/restore', { method: 'POST' })).status).toBe(404);
  const restored = await t.request(`/api/v1/recyclebin/${entry.id}/restore`, { method: 'POST' });
  expect(await restored.json()).toMatchObject({ id: entry.id, restoredAt: expect.any(String) });

  const again = await t.ctx.services.recycleBin.recycle(file, {});
  expect((await t.request(`/api/v1/recyclebin/${again.id}`, { method: 'DELETE' })).status).toBe(204);
  expect((await t.request(`/api/v1/recyclebin/${again.id}`, { method: 'DELETE' })).status).toBe(409);
});
