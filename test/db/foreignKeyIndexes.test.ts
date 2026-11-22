import { afterAll, expect, test } from 'bun:test';
import { tempPathReferencedQuery } from '../../src/modules/jobs/jobQueries.ts';
import { createTestContext } from '../helpers/context.ts';
import { queryPlan } from '../helpers/queryPlan.ts';

const t = createTestContext();
afterAll(() => t.cleanup());

test.each<[string, string, string, number[]]>([
  ['jobs.library_id', 'SELECT 1 FROM jobs WHERE library_id = ?', 'jobs_library_idx', [1]],
  ['jobs.profile_id', 'SELECT 1 FROM jobs WHERE profile_id = ?', 'jobs_profile_idx', [1]],
  [
    'jobs.recycle_bin_entry_id',
    'UPDATE jobs SET recycle_bin_entry_id = NULL WHERE recycle_bin_entry_id = ?',
    'jobs_recycle_bin_entry_idx',
    [1],
  ],
  ['media_files.root_id', 'SELECT 1 FROM media_files WHERE root_id = ?', 'media_files_root_idx', [1]],
  [
    'media_files keyset walk of one root',
    'SELECT id FROM media_files WHERE root_id = ? AND id > ? ORDER BY id LIMIT 500',
    'media_files_root_idx',
    [1, 0],
  ],
  [
    'library_profiles.profile_id',
    'SELECT 1 FROM library_profiles WHERE profile_id = ?',
    'library_profiles_profile_idx',
    [1],
  ],
])('%s - a lookup by the column uses its index', (_name, sql, index, params) => {
  const plan = queryPlan(t, sql, params);

  expect(plan).toEqual([expect.stringContaining(index)]);
});

test('library_profiles - the libraries of a profile come back ordered without a sort step', () => {
  const plan = queryPlan(t, 'SELECT library_id FROM library_profiles WHERE profile_id = ? ORDER BY library_id', [1]);

  expect(plan).toEqual([expect.stringContaining('library_profiles_profile_idx')]);
});

test('tempPathReferencedQuery - looks the temp path up through its index', () => {
  const { sql, params } = tempPathReferencedQuery(t.ctx.db, '/m/.wololo-tmp-3').toSQL();

  expect(queryPlan(t, sql, params)).toEqual([expect.stringContaining('jobs_temp_path_idx')]);
});
