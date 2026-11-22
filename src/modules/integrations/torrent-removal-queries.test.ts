import { afterEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { queryPlan } from '../../../test/helpers/queryPlan.ts';
import type { Db } from '../../db/client.ts';
import { audioJobSourcePathsQuery, libraryCopiesAtQuery, restoredSinceQuery } from './seeding-query.ts';
import {
  finishTorrentRemoval,
  hasPendingTorrentRemoval,
  keepTorrentRemovalPending,
  pendingTorrentRemovals,
  pendingTorrentRemovalsQuery,
  requestTorrentRemoval,
} from './torrent-removal-queries.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

test('requestTorrentRemoval - one row per hash; a new request restarts a finished one', () => {
  t = createTestContext();
  requestTorrentRemoval(t.ctx.db, { hash: 'abc', name: 'Show', condition: 'converted' }, T0);
  expect(finishTorrentRemoval(t.ctx.db, 'abc', { state: 'cancelled', reason: 'kept' }, T0)).toBe(true);
  expect(hasPendingTorrentRemoval(t.ctx.db)).toBe(false);

  const again = requestTorrentRemoval(t.ctx.db, { hash: 'abc', name: 'Show', condition: 'converted_and_seeded' }, T1);

  expect(again).toMatchObject({ state: 'pending', reason: null, createdAt: T1, finishedAt: null });
  expect(pendingTorrentRemovals(t.ctx.db, 10).map((row) => [row.hash, row.condition])).toEqual([
    ['abc', 'converted_and_seeded'],
  ]);
});

test('finishTorrentRemoval - only a pending request can finish', () => {
  t = createTestContext();
  requestTorrentRemoval(t.ctx.db, { hash: 'abc', name: 'Show', condition: 'converted' }, T0);
  expect(finishTorrentRemoval(t.ctx.db, 'abc', { state: 'removed', reason: null }, T1)).toBe(true);
  expect(finishTorrentRemoval(t.ctx.db, 'abc', { state: 'cancelled', reason: 'kept' }, T1)).toBe(false);
  expect(finishTorrentRemoval(t.ctx.db, 'other', { state: 'removed', reason: null }, T1)).toBe(false);
});

test('keepTorrentRemovalPending - records the reason and skips an unchanged one', () => {
  t = createTestContext();
  const row = requestTorrentRemoval(t.ctx.db, { hash: 'abc', name: 'Show', condition: 'converted' }, T0);
  keepTorrentRemovalPending(t.ctx.db, row, '1 of 2 file(s) converted');
  const [kept] = pendingTorrentRemovals(t.ctx.db, 10);
  expect(kept?.reason).toBe('1 of 2 file(s) converted');
  expect(kept?.state).toBe('pending');
});

test.each([
  ['pendingTorrentRemovalsQuery', (db: Db) => pendingTorrentRemovalsQuery(db, 50), 'torrent_removals_state_idx'],
  ['libraryCopiesAtQuery', (db: Db) => libraryCopiesAtQuery(db, ['/a.mkv', '/b.mkv']), 'media_files_path_idx'],
  ['audioJobSourcePathsQuery', (db: Db) => audioJobSourcePathsQuery(db, 1), 'jobs_media_file_idx'],
  ['restoredSinceQuery', (db: Db) => restoredSinceQuery(db, [1, 2], T0), 'recycle_bin_media_file_idx'],
] as const)('%s - reads through its index', (_name, build, index) => {
  const context = createTestContext();
  t = context;
  const { sql, params } = build(context.ctx.db).toSQL();
  const plan = queryPlan(context, sql, params);
  expect(
    plan.some((detail) => detail.includes(index)),
    plan.join('\n'),
  ).toBe(true);
});
