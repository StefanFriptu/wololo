import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { ProfileService } from '../../contracts/rules-ffmpeg.ts';
import type {
  ApiErrorBody,
  DryRunReport,
  FilesystemListing,
  MediaFileDetail,
  MediaFileSummary,
  MediaStats,
  Paginated,
  ScanStatus,
} from '../../shared/api-types.ts';
import type { ConversionPlan, Library, ScheduledTaskInfo } from '../../shared/domain.ts';
import type { EventMap } from '../../shared/events.ts';
import { fakeJobs, fakeRules, TEST_DEFINITION } from './test-fakes.ts';

let t: TestContext;
let root: string;

beforeAll(async () => {
  t = createTestContext({
    overrides: {
      rules: fakeRules(),
      jobs: fakeJobs(() => t.ctx.db).service,
      profiles: stubService<ProfileService>('profiles', {
        getDefault: async () => ({
          id: 1,
          name: 'Samsung Tizen',
          description: '',
          version: 1,
          builtin: true,
          definition: TEST_DEFINITION,
          createdAt: '',
          updatedAt: '',
        }),
      }),
    },
  });
  root = join(t.dir, 'movies');
  mkdirSync(root, { recursive: true });
  await t.ctx.services.libraries.create({ name: 'Movies', kind: 'movies', roots: [root], profileIds: [] });
});

afterAll(() => t.cleanup());

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function call<T>(path: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await t.request(path, init);
  const text = await response.text();
  if (response.status !== status) throw new Error(`${path}: expected ${status}, got ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function scanAndWait(): Promise<void> {
  const done = new Promise<EventMap['scan.finished']>((resolve) => {
    const off = t.ctx.events.on('scan.finished', (payload) => {
      off();
      resolve(payload);
    });
  });
  const started = await call<ScanStatus>('/api/v1/scans', json({}));
  expect(started.running).toBe(true);
  await done;
}

describe('libraries and filesystem routes', () => {
  test('POST/GET/PUT/DELETE /api/v1/libraries round trip', async () => {
    const created = await call<Library>(
      '/api/v1/libraries',
      json({ name: 'Temp', kind: 'series', roots: ['/srv/tv'], profileIds: [] }),
    );
    expect(created).toMatchObject({ name: 'Temp', kind: 'series', roots: [{ path: '/srv/tv', accessible: false }] });
    expect((await call<Library>(`/api/v1/libraries/${created.id}`)).name).toBe('Temp');
    const updated = await call<Library>(
      `/api/v1/libraries/${created.id}`,
      json({ name: 'TV', kind: 'series', roots: ['/srv/tv'], profileIds: [], mode: 'keep_both' }, 'PUT'),
    );
    expect(updated).toMatchObject({ name: 'TV', mode: 'keep_both' });
    expect(await call(`/api/v1/libraries/${created.id}`, { method: 'DELETE' }, 204)).toBeUndefined();
    await call(`/api/v1/libraries/${created.id}`, undefined, 404);
  });

  test('POST /api/v1/libraries validates the body without leaking internals', async () => {
    const body = await call<ApiErrorBody>('/api/v1/libraries', json({ name: '', kind: 'films', roots: [] }), 400);
    expect(body.error).toBe('validation');
    expect(JSON.stringify(body)).not.toContain('SELECT');
    const duplicate = await call<ApiErrorBody>(
      '/api/v1/libraries',
      json({ name: 'Movies', kind: 'movies', roots: ['/other'], profileIds: [] }),
      409,
    );
    expect(duplicate.error).toBe('conflict');
    await call('/api/v1/libraries/abc', undefined, 400);
  });

  test('GET /api/v1/filesystem lists directories, files on request', async () => {
    const listing = await call<FilesystemListing>(`/api/v1/filesystem?path=${encodeURIComponent(t.dir)}`);
    expect(listing.entries.map((entry) => entry.name)).toContain('movies');
    expect(listing.entries.every((entry) => entry.type === 'dir')).toBe(true);
    const withFiles = await call<FilesystemListing>(
      `/api/v1/filesystem?path=${encodeURIComponent(t.dir)}&includeFiles=true`,
    );
    expect(withFiles.entries.some((entry) => entry.type === 'file')).toBe(true);
    await call(`/api/v1/filesystem?path=${encodeURIComponent(join(t.dir, 'missing'))}`, undefined, 404);
  });
});

describe('scheduler routes', () => {
  test('GET /api/v1/system/tasks lists every task with defaults', async () => {
    const tasks = await call<ScheduledTaskInfo[]>('/api/v1/system/tasks');
    expect(tasks.map((task) => [task.name, task.intervalMinutes])).toEqual([
      ['library_scan', 360],
      ['recycle_bin_purge', 60],
      ['seeding_check', 30],
      ['backup', 10080],
      ['housekeeping', 1440],
      ['log_cleanup', 1440],
    ]);
  });

  test('PUT /api/v1/system/tasks/:name changes the interval and validates input', async () => {
    const task = await call<ScheduledTaskInfo>(
      '/api/v1/system/tasks/backup',
      json({ intervalMinutes: 60, enabled: false }, 'PUT'),
    );
    expect(task).toMatchObject({ name: 'backup', intervalMinutes: 60, enabled: false, nextRunAt: null });
    await call('/api/v1/system/tasks/backup', json({ intervalMinutes: 0 }, 'PUT'), 400);
    await call('/api/v1/system/tasks/nope', json({ enabled: true }, 'PUT'), 400);
  });

  test('POST /api/v1/system/tasks/:name/run starts the task', async () => {
    const finished = new Promise<EventMap['task.finished']>((resolve) => {
      const off = t.ctx.events.on('task.finished', (payload) => {
        off();
        resolve(payload);
      });
    });
    const task = await call<ScheduledTaskInfo>('/api/v1/system/tasks/library_scan/run', { method: 'POST' });
    expect(task).toMatchObject({ name: 'library_scan', running: true });
    expect((await finished).task).toMatchObject({ name: 'library_scan', running: false });
  });
});

describe.skipIf(!ffmpegAvailable())('media, scan and dry-run routes', () => {
  let detail: MediaFileDetail;

  beforeAll(async () => {
    await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    await ensureFixtureCopy(FIXTURES.ac3Compatible, root, 'Ok.mkv');
    await scanAndWait();
  });

  test('GET /api/v1/scans/current returns the last scan', async () => {
    const current = await call<ScanStatus>('/api/v1/scans/current');
    expect(current).toMatchObject({ running: false, error: null, stats: { filesSeen: 2, filesProbed: 2 } });
    expect(await call('/api/v1/scans/current', { method: 'DELETE' }, 204)).toBeUndefined();
  });

  test('GET /api/v1/media lists with filters and validates the query', async () => {
    const page = await call<Paginated<MediaFileSummary>>('/api/v1/media?status=needs_work&failingCodec=dts');
    expect(page.total).toBe(1);
    expect(page.items[0]?.relativePath).toBe('Movie.mkv');
    const all = await call<Paginated<MediaFileSummary>>('/api/v1/media?sortKey=size&sortDir=desc&pageSize=1');
    expect(all).toMatchObject({ total: 2, pageSize: 1 });
    const bad = await call<ApiErrorBody>('/api/v1/media?status=done', undefined, 400);
    expect(bad.error).toBe('validation');
    await call('/api/v1/media?pageSize=0', undefined, 400);
    detail = await call<MediaFileDetail>(`/api/v1/media/${page.items[0]?.id}`);
    expect(detail.probe?.streams).toHaveLength(3);
  });

  test('GET /api/v1/media/stats counts statuses', async () => {
    const stats = await call<MediaStats>('/api/v1/media/stats');
    expect(stats.byStatus).toMatchObject({ needs_work: 1, compatible: 1 });
    expect(stats.byFailingCodec).toEqual([{ codec: 'dts', count: 1 }]);
  });

  test('GET /api/v1/media/:id/plan and POST /api/v1/media/:id/probe', async () => {
    const plan = await call<ConversionPlan>(`/api/v1/media/${detail.id}/plan`);
    expect(plan.action).toBe('convert');
    const probed = await call<MediaFileDetail>(`/api/v1/media/${detail.id}/probe`, { method: 'POST' });
    expect(probed.probedAt).not.toBe(detail.probedAt);
    await call('/api/v1/media/9999/plan', undefined, 404);
  });

  test('PUT /api/v1/media/:id/ignore toggles ignore', async () => {
    const ignored = await call<MediaFileSummary>(`/api/v1/media/${detail.id}/ignore`, json({ ignored: true }, 'PUT'));
    expect(ignored.status).toBe('ignored');
    const back = await call<MediaFileSummary>(`/api/v1/media/${detail.id}/ignore`, json({ ignored: false }, 'PUT'));
    expect(back.status).toBe('needs_work');
    await call(`/api/v1/media/${detail.id}/ignore`, json({ ignored: 'yes' }, 'PUT'), 400);
  });

  test('GET /api/v1/dryrun reports failing codecs with estimates', async () => {
    const report = await call<DryRunReport>('/api/v1/dryrun');
    expect(report.totals).toMatchObject({ files: 2, needsWork: 1, compatible: 1 });
    expect(report.groups.map((group) => group.codec)).toEqual(['dts']);
    expect(report.estimatedSeconds).toBeGreaterThanOrEqual(0);
    expect(report.byProfile).toMatchObject([{ profileId: 1, files: 2, failing: 1 }]);
    await call('/api/v1/dryrun?libraryId=abc', undefined, 400);
  });
});
