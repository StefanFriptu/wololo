import type { SQLQueryBindings } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob } from '../../../test/helpers/seed.ts';
import {
  finishedJobIdsBefore,
  finishedJobIdsBeforeQuery,
  isTempPathReferenced,
  prunableJobIdsQuery,
  tempPathReferencedQuery,
} from './jobQueries.ts';

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

function queryPlan(context: TestContext, sql: string, params: readonly unknown[] = []): string[] {
  return context.ctx.dbHandle.sqlite
    .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as SQLQueryBindings[]))
    .map((row) => row.detail);
}

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
