import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertArrInstance, insertJob, insertMediaFile, insertProfile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { JobsService } from '../../contracts/jobs.ts';
import type { MediaService } from '../../contracts/probe-scan.ts';
import { AppError, type ErrorCode } from '../../core/errors.ts';
import { jobs, mediaFiles } from '../../db/schema.ts';
import type { LibraryInput } from '../../shared/api-types.ts';
import type { JobSummary } from '../../shared/domain.ts';
import { TEST_DEFINITION } from './test-fakes.ts';

let t: TestContext;
let invalidations: { libraryId?: number; profileId?: number }[];

beforeEach(() => {
  invalidations = [];
  t = createTestContext({
    overrides: {
      media: stubService<MediaService>('media', {
        invalidateRules: async (filter) => {
          invalidations.push(filter);
          return 0;
        },
      }),
    },
  });
});

afterEach(() => t.cleanup());

const input = (overrides: Partial<LibraryInput> = {}): LibraryInput => ({
  name: 'Movies',
  kind: 'movies',
  roots: [join(t.dir, 'movies')],
  profileIds: [],
  ...overrides,
});

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

test('libraries.create - stores defaults, normalises roots and languages, reports disk info', async () => {
  mkdirSync(join(t.dir, 'movies'));
  const profileId = insertProfile(t.ctx.db, TEST_DEFINITION);
  const library = await t.ctx.services.libraries.create(
    input({
      roots: [`${join(t.dir, 'movies')}/`, join(t.dir, 'missing')],
      profileIds: [profileId, profileId],
      keepLanguages: ['de', 'English', 'spa'],
      fillMissingLanguage: 'fra',
    }),
  );
  expect(library).toMatchObject({
    name: 'Movies',
    kind: 'movies',
    enabled: true,
    profileIds: [profileId],
    mode: 'replace',
    keepLanguages: ['ger', 'eng', 'spa'],
    keepOriginalLanguage: true,
    keepUndetermined: true,
    fillMissingLanguage: 'fre',
    arrInstanceId: null,
    bdmvEnabled: true,
    discsOnly: false,
  });
  const [movies, missing] = library.roots;
  expect(movies?.path).toBe(join(t.dir, 'movies'));
  expect(movies?.accessible).toBe(true);
  expect(movies?.freeBytes).toBeGreaterThan(0);
  expect(missing).toMatchObject({ accessible: false, freeBytes: null });
  expect(await t.ctx.services.libraries.list()).toHaveLength(1);
});

test.each<[string, Partial<LibraryInput>, ErrorCode]>([
  ['relative root', { roots: ['media/movies'] }, 'validation'],
  ['overlapping roots', { roots: ['/data/media', '/data/media/movies'] }, 'validation'],
  ['unknown profile', { profileIds: [999] }, 'validation'],
  ['unknown language', { keepLanguages: ['klingonese'] }, 'validation'],
  ['unknown fill language', { fillMissingLanguage: 'xx-nonsense-1' }, 'validation'],
  ['unknown arr instance', { arrInstanceId: 42 }, 'validation'],
])('libraries.create - rejects %s', async (_label, overrides, code) => {
  expect((await errorOf(t.ctx.services.libraries.create(input(overrides)))).code).toBe(code);
});

test('libraries.create - discs only is stored, and refused without Blu-ray conversion', async () => {
  expect(await errorOf(t.ctx.services.libraries.create(input({ discsOnly: true, bdmvEnabled: false })))).toMatchObject({
    code: 'validation',
    message: expect.stringContaining('needs Blu-ray conversion'),
  });
  expect(await t.ctx.services.libraries.list()).toHaveLength(0);
  expect(await t.ctx.services.libraries.create(input({ discsOnly: true }))).toMatchObject({
    bdmvEnabled: true,
    discsOnly: true,
  });
});

test('libraries.create - duplicate names and roots overlapping another library are conflicts', async () => {
  await t.ctx.services.libraries.create(input({ roots: ['/data/media/movies'] }));
  expect((await errorOf(t.ctx.services.libraries.create(input({ roots: ['/data/other'] })))).code).toBe('conflict');
  const nested = t.ctx.services.libraries.create(input({ name: 'Nested', roots: ['/data/media/movies/4k'] }));
  expect((await errorOf(nested)).code).toBe('conflict');
  const parent = t.ctx.services.libraries.create(input({ name: 'Parent', roots: ['/data/media'] }));
  expect((await errorOf(parent)).code).toBe('conflict');
  const sibling = await t.ctx.services.libraries.create(input({ name: 'Movies 2', roots: ['/data/media/movies2'] }));
  expect(sibling.roots[0]?.path).toBe('/data/media/movies2');
});

test('libraries.update - keeps unchanged roots and their files, drops removed roots, re-checks on rule changes', async () => {
  const arrId = insertArrInstance(t.ctx.db);
  const created = await t.ctx.services.libraries.create(input({ roots: ['/data/a', '/data/b'] }));
  const [rootA, rootB] = created.roots;
  const library = { libraryId: created.id, rootIds: [rootA?.id as number, rootB?.id as number] };
  const keptFile = insertMediaFile(t.ctx.db, library, { path: '/data/a/x.mkv' });
  insertMediaFile(t.ctx.db, { ...library, rootIds: [rootB?.id as number] }, { path: '/data/b/y.mkv' });

  const renamed = await t.ctx.services.libraries.update(
    created.id,
    input({ name: 'Films', roots: ['/data/a', '/data/c'], arrInstanceId: arrId, enabled: false }),
  );
  expect(renamed.name).toBe('Films');
  expect(renamed.enabled).toBe(false);
  expect(renamed.arrInstanceId).toBe(arrId);
  expect(renamed.roots.map((root) => root.path)).toEqual(['/data/a', '/data/c']);
  expect(renamed.roots[0]?.id).toBe(rootA?.id as number);
  expect(t.ctx.db.select({ path: mediaFiles.path }).from(mediaFiles).all()).toEqual([{ path: keptFile.path }]);
  expect(invalidations).toEqual([]);

  const relanguaged = await t.ctx.services.libraries.update(
    created.id,
    input({ roots: ['/data/a'], keepLanguages: ['en'] }),
  );
  expect(relanguaged.keepLanguages).toEqual(['eng']);
  expect(relanguaged.arrInstanceId).toBe(arrId);
  expect(invalidations).toEqual([{ libraryId: created.id }]);
});

test('libraries.update - unknown library is not_found', async () => {
  expect((await errorOf(t.ctx.services.libraries.update(99, input()))).code).toBe('not_found');
});

test('libraries.remove - deletes the library and its rows, refuses while a job runs', async () => {
  const created = await t.ctx.services.libraries.create(input({ roots: ['/data/a'] }));
  const seeded = { libraryId: created.id, rootIds: [created.roots[0]?.id as number] };
  const row = insertMediaFile(t.ctx.db, seeded, { path: '/data/a/x.mkv' });
  const job = insertJob(t.ctx.db, { sourcePath: row.path, libraryId: created.id, state: 'running' });
  expect((await errorOf(t.ctx.services.libraries.remove(created.id))).code).toBe('conflict');

  t.ctx.db.update(jobs).set({ state: 'completed' }).where(eq(jobs.id, job.id)).run();
  await t.ctx.services.libraries.remove(created.id);
  expect(await t.ctx.services.libraries.list()).toEqual([]);
  expect(t.ctx.db.select().from(mediaFiles).all()).toEqual([]);
  expect((await errorOf(t.ctx.services.libraries.remove(created.id))).code).toBe('not_found');
});

test("libraries.remove - cancels the library's queued jobs first; a failed cancel keeps the library", async () => {
  const created = await t.ctx.services.libraries.create(input({ roots: ['/data/a'] }));
  const seeded = { libraryId: created.id, rootIds: [created.roots[0]?.id as number] };
  const row = insertMediaFile(t.ctx.db, seeded, { path: '/data/a/x.mkv' });
  const byLibrary = insertJob(t.ctx.db, { sourcePath: row.path, libraryId: created.id, state: 'queued' });
  const byMedia = insertJob(t.ctx.db, { sourcePath: row.path, mediaFileId: row.id, state: 'queued' });
  const cancelled: number[] = [];
  let failCancel = true;
  t.ctx.services.jobs = stubService<JobsService>('jobs', {
    cancel: async (id) => {
      if (failCancel) throw new Error('queue busy');
      cancelled.push(id);
      t.ctx.db.update(jobs).set({ state: 'cancelled' }).where(eq(jobs.id, id)).run();
      return { id, state: 'cancelled' } as JobSummary;
    },
  });
  expect((await errorOf(t.ctx.services.libraries.remove(created.id))).code).toBe('conflict');
  expect(await t.ctx.services.libraries.list()).toHaveLength(1);

  failCancel = false;
  await t.ctx.services.libraries.remove(created.id);
  expect(cancelled.sort()).toEqual([byLibrary.id, byMedia.id].sort());
  expect(await t.ctx.services.libraries.list()).toEqual([]);
});

test('libraries.findRootForPath - longest matching root across libraries', async () => {
  const media = await t.ctx.services.libraries.create(input({ name: 'All', roots: ['/data/media'] }));
  const kids = await t.ctx.services.libraries.create(input({ name: 'Kids', roots: ['/data/kids', '/data/kids-4k'] }));
  const found = await t.ctx.services.libraries.findRootForPath('/data/kids-4k/Film/a.mkv');
  expect(found?.library.id).toBe(kids.id);
  expect(found?.rootPath).toBe('/data/kids-4k');
  expect(found?.rootId).toBe(kids.roots[1]?.id as number);
  expect((await t.ctx.services.libraries.findRootForPath('/data/media/x.mkv'))?.library.id).toBe(media.id);
  expect(await t.ctx.services.libraries.findRootForPath('/data/kidsx/a.mkv')).toBeNull();
  expect(await t.ctx.services.libraries.findRootForPath('relative/a.mkv')).toBeNull();
});

test('libraries.browse - directories first, files on request, hidden entries skipped', async () => {
  const base = join(t.dir, 'browse');
  mkdirSync(join(base, 'b-dir'), { recursive: true });
  mkdirSync(join(base, 'A-dir'));
  mkdirSync(join(base, '.hidden'));
  writeFileSync(join(base, 'file.mkv'), 'abc');
  const dirsOnly = await t.ctx.services.libraries.browse({ path: base });
  expect(dirsOnly.path).toBe(base);
  expect(dirsOnly.parent).toBe(t.dir);
  expect(dirsOnly.entries.map((entry) => entry.name)).toEqual(['A-dir', 'b-dir']);
  const withFiles = await t.ctx.services.libraries.browse({ path: base, includeFiles: true });
  expect(withFiles.entries.at(-1)).toEqual({
    name: 'file.mkv',
    path: join(base, 'file.mkv'),
    type: 'file',
    sizeBytes: 3,
  });
});

test('libraries.browse - filesystem root has no parent; missing and file paths are errors', async () => {
  expect((await t.ctx.services.libraries.browse({})).parent).toBeNull();
  expect((await errorOf(t.ctx.services.libraries.browse({ path: join(t.dir, 'nope') }))).code).toBe('not_found');
  writeFileSync(join(t.dir, 'plain.txt'), 'x');
  expect((await errorOf(t.ctx.services.libraries.browse({ path: join(t.dir, 'plain.txt') }))).code).toBe('validation');
});
