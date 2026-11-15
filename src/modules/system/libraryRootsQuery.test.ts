import { afterAll, expect, test } from 'bun:test';
import { createTestContext } from '../../../test/helpers/context.ts';
import { insertLibrary } from '../../../test/helpers/seed.ts';
import { enabledLibraryRootsQuery, libraryCountQuery } from './libraryRootsQuery.ts';

const t = createTestContext();
afterAll(() => t.cleanup());

test('enabledLibraryRootsQuery - joins roots to enabled libraries, ordered by library and path', () => {
  const { sql, params } = enabledLibraryRootsQuery(t.ctx.db).toSQL();
  expect(sql).toBe(
    'select "libraries"."name", "library_roots"."path" from "library_roots" ' +
      'inner join "libraries" on "library_roots"."library_id" = "libraries"."id" ' +
      'where "libraries"."enabled" = ? order by "libraries"."name", "library_roots"."path"',
  );
  expect(params).toEqual([1]);
});

test('enabledLibraryRootsQuery - skips the roots of disabled libraries', () => {
  insertLibrary(t.ctx.db, { name: 'Movies', roots: ['/data/media/movies', '/data/media/4k'] });
  insertLibrary(t.ctx.db, { name: 'Old', enabled: false, roots: ['/data/old'] });
  expect(enabledLibraryRootsQuery(t.ctx.db).all()).toEqual([
    { library: 'Movies', path: '/data/media/4k' },
    { library: 'Movies', path: '/data/media/movies' },
  ]);
});

test('libraryCountQuery - counts every library', () => {
  const { sql, params } = libraryCountQuery(t.ctx.db).toSQL();
  expect(sql).toBe('select count(*) from "libraries"');
  expect(params).toEqual([]);
});
