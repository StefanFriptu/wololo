import { afterAll, expect, test } from 'bun:test';
import { createTestContext } from '../../../test/helpers/context.ts';
import { insertJob } from '../../../test/helpers/seed.ts';
import { IN_LIST_CHUNK_SIZE } from '../../core/chunk.ts';
import { existingJobIdsQuery } from './existingJobIdsQuery.ts';

const t = createTestContext();
afterAll(() => t.cleanup());

test('existingJobIdsQuery - selects job ids in the given set', () => {
  const queries = existingJobIdsQuery(t.ctx.db, [4, 8]);
  expect(queries.map((query) => query.toSQL())).toEqual([
    { sql: 'select "id" from "jobs" where "jobs"."id" in (?, ?)', params: [4, 8] },
  ]);
});

test('existingJobIdsQuery - splits more than 500 ids into chunks', () => {
  const ids = Array.from({ length: IN_LIST_CHUNK_SIZE * 2 + 1 }, (_, index) => index + 1);
  const params = existingJobIdsQuery(t.ctx.db, ids).map((query) => query.toSQL().params);
  expect(params.map((chunk) => chunk.length)).toEqual([IN_LIST_CHUNK_SIZE, IN_LIST_CHUNK_SIZE, 1]);
  expect(params.flat()).toEqual(ids);
});

test('existingJobIdsQuery - no ids means no query', () => {
  expect(existingJobIdsQuery(t.ctx.db, [])).toEqual([]);
});

test('existingJobIdsQuery - finds rows across chunks', () => {
  const first = insertJob(t.ctx.db, { sourcePath: '/data/media/a.mkv' });
  const last = insertJob(t.ctx.db, { sourcePath: '/data/media/b.mkv' });
  const ids = [first.id, ...Array.from({ length: IN_LIST_CHUNK_SIZE }, (_, index) => 900_000 + index), last.id];
  const found = existingJobIdsQuery(t.ctx.db, ids).flatMap((query) => query.all().map((row) => row.id));
  expect(found.sort((a, b) => a - b)).toEqual([first.id, last.id]);
});
