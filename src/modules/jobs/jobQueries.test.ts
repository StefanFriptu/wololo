import { afterEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { queryPlan } from '../../../test/helpers/queryPlan.ts';
import { insertJob } from '../../../test/helpers/seed.ts';
import type { JobRow, NewJobRow } from '../../db/schema.ts';
import {
  finishedJobIdsBefore,
  finishedJobIdsBeforeQuery,
  getJobRow,
  isTempPathReferenced,
  listJobRows,
  prunableJobIdsQuery,
  queueRows,
  tempPathReferencedQuery,
} from './jobQueries.ts';
import { toJobSummary } from './mappers.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

test('finishedJobIdsBeforeQuery - filters state and finish time in SQL', () => {
  t = createTestContext();
  const { sql, params } = finishedJobIdsBeforeQuery(t.ctx.db, {
    ids: [1, 2],
    beforeIso: '2026-01-01T00:00:00.000Z',
  }).toSQL();

  expect(flat(sql)).toBe(
    'select "id" from "jobs" where ("jobs"."id" in (?, ?) and "jobs"."state" not in (?, ?) and "jobs"."finished_at" is not null and "jobs"."finished_at" < ?)',
  );
  expect(params).toEqual([1, 2, 'queued', 'running', '2026-01-01T00:00:00.000Z']);
});

test('finishedJobIdsBefore - only finished jobs older than the cutoff', () => {
  t = createTestContext();
  const old = insertJob(t.ctx.db, { sourcePath: '/a', state: 'completed', finishedAt: '2025-01-01T00:00:00.000Z' });
  const recent = insertJob(t.ctx.db, { sourcePath: '/b', state: 'failed', finishedAt: '2026-06-01T00:00:00.000Z' });
  const running = insertJob(t.ctx.db, { sourcePath: '/c', state: 'running', finishedAt: '2025-01-01T00:00:00.000Z' });
  const ids = [old.id, recent.id, running.id];

  expect([...finishedJobIdsBefore(t.ctx.db, ids, '2026-01-01T00:00:00.000Z')]).toEqual([old.id]);
  expect(finishedJobIdsBefore(t.ctx.db, [], '2026-01-01T00:00:00.000Z').size).toBe(0);
});

test('tempPathReferencedQuery - matches the path with and without a trailing slash', () => {
  t = createTestContext();
  const { sql, params } = tempPathReferencedQuery(t.ctx.db, '/m/.wololo-tmp-3').toSQL();

  expect(flat(sql)).toBe('select "id" from "jobs" where "jobs"."temp_path" in (?, ?) limit ?');
  expect(params).toEqual(['/m/.wololo-tmp-3', '/m/.wololo-tmp-3/', 1]);
});

test('isTempPathReferenced - true only for paths a job row holds', () => {
  t = createTestContext();
  insertJob(t.ctx.db, { sourcePath: '/m/Disc', type: 'bdmv', tempPath: '/m/.wololo-tmp-3/' });

  expect(isTempPathReferenced(t.ctx.db, '/m/.wololo-tmp-3')).toBe(true);
  expect(isTempPathReferenced(t.ctx.db, '/m/.wololo-tmp-4')).toBe(false);
});

test('prunableJobIdsQuery - finds media and recycle-bin references through their indexes', () => {
  t = createTestContext();
  const { sql, params } = prunableJobIdsQuery(t.ctx.db, { beforeIso: '2026-01-01T00:00:00.000Z', limit: 500 }).toSQL();

  const plan = queryPlan(t, sql, params);

  expect(plan.some((detail) => detail.includes('media_files_last_job_idx'))).toBe(true);
  expect(plan.some((detail) => detail.includes('recycle_bin_job_idx'))).toBe(true);
});

test('recycle_bin - the media file foreign key action looks rows up by index', () => {
  t = createTestContext();

  const plan = queryPlan(t, 'SELECT 1 FROM recycle_bin WHERE media_file_id = ?', [1]);

  expect(plan).toEqual([expect.stringContaining('recycle_bin_media_file_idx')]);
});

test('queueRows and listJobRows - summaries match the ones built from full rows', () => {
  t = createTestContext();
  const { db } = t.ctx;
  const heavy = {
    plan: { steps: [] },
    bdmvPlan: { playlists: [] },
    beforeStreams: [],
    afterStreams: [],
    lostFeatures: ['dts-x'],
    verification: { ok: true },
  } as unknown as Partial<NewJobRow>;
  const running = insertJob(db, { sourcePath: '/r', state: 'running', progress: 0.4, speed: 2, etaSec: 9, ...heavy });
  const low = insertJob(db, { sourcePath: '/low', state: 'queued', priority: 0, ...heavy });
  const high = insertJob(db, { sourcePath: '/high', state: 'queued', priority: 5, error: 'x', attempts: 2, ...heavy });
  const done = insertJob(db, { sourcePath: '/done', state: 'completed', finishedAt: '2026-01-01T00:00:00.000Z' });
  const summaryOf = (id: number) => toJobSummary(getJobRow(db, id) as JobRow);

  const queue = queueRows(db, 10);
  expect(queue.map((row) => row.id)).toEqual([running.id, high.id, low.id]);
  expect(JSON.stringify(queue.map((row) => toJobSummary(row)))).toBe(
    JSON.stringify([running, high, low].map((row) => summaryOf(row.id))),
  );
  expect(queueRows(db, 1).map((row) => row.id)).toEqual([running.id, high.id]);

  const page = listJobRows(db, {}, { page: 1, pageSize: 3, sortDir: 'desc' });
  expect(page.total).toBe(4);
  expect(page.rows.map((row) => row.id)).toEqual([done.id, high.id, low.id]);
  expect(JSON.stringify(page.rows.map((row) => toJobSummary(row)))).toBe(
    JSON.stringify([done, high, low].map((row) => summaryOf(row.id))),
  );
  expect(Object.keys(page.rows[0] ?? {})).not.toContain('plan');
});
