import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { FileChangedEvent, NotifierService } from '../../contracts/integrations.ts';
import type { LibraryService, MediaService } from '../../contracts/probe-scan.ts';
import { AppError, type ErrorCode } from '../../core/errors.ts';
import { recycleBin } from '../../db/schema.ts';
import { getJobRow } from '../jobs/jobQueries.ts';
import { type MediaRecorder, mediaDetail, recordingMediaService } from '../jobs/test-support.ts';
import { createRecycleBinService } from './index.ts';
import { getRecycleRow } from './recycleBinQueries.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

interface Setup {
  t: TestContext;
  root: string;
  source: string;
  mediaFileId: number;
  jobId: number;
  recorder: MediaRecorder & { service: MediaService };
  notified: FileChangedEvent[];
}

function setup(options: { rootKnown?: boolean } = {}): Setup {
  const holder = { root: '' };
  const notified: FileChangedEvent[] = [];
  const { service, recorder } = recordingMediaService([]);
  const context = createTestContext({
    overrides: {
      media: service,
      libraries: stubService<LibraryService>('libraries', {
        findRootForPath: async () => {
          if (options.rootKnown === false) throw new Error('library service unavailable');
          return { library: {} as never, rootId: 1, rootPath: holder.root };
        },
      }),
      notifier: stubService<NotifierService>('notifier', {
        fileChanged: async (event) => {
          notified.push(event);
        },
      }),
    },
  });
  holder.root = join(context.dir, 'movies');
  const source = join(holder.root, 'Movie (2020)', 'Movie (2020).mkv');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'original');
  const library = insertLibrary(context.ctx.db, { roots: [holder.root] });
  const media = insertMediaFile(context.ctx.db, library, { path: source });
  recorder.files.set(media.id, mediaDetail(media.id, source));
  const job = insertJob(context.ctx.db, { sourcePath: source, mediaFileId: media.id, state: 'running' });
  return {
    t: context,
    root: holder.root,
    source,
    mediaFileId: media.id,
    jobId: job.id,
    recorder: { ...recorder, service },
    notified,
  };
}

async function expectAppError(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

test('recycleForReplace - hard-links the original into the library bin and leaves it in place', async () => {
  const s = setup();
  t = s.t;

  const { entry, mode } = await t.ctx.services.recycleBin.recycleForReplace(s.source, {
    jobId: s.jobId,
    mediaFileId: s.mediaFileId,
  });

  expect(mode).toBe('link');
  expect(existsSync(s.source)).toBe(true);
  expect(statSync(entry.recyclePath).ino).toBe(statSync(s.source).ino);
  expect(entry.recyclePath).toMatch(
    new RegExp(`^${s.root}/\\.wololo-recycle/\\d{8}T\\d{6}Z/Movie \\(2020\\)/Movie \\(2020\\)\\.mkv$`),
  );
  expect(entry).toMatchObject({ originalPath: s.source, sizeBytes: 8, jobId: s.jobId, mediaFileId: s.mediaFileId });
  expect(Date.parse(entry.expiresAt) - Date.parse(entry.createdAt)).toBeGreaterThan(6.9 * 86_400_000);
  expect(getJobRow(t.ctx.db, s.jobId)?.recycleBinEntryId).toBe(entry.id);
  const history = await t.ctx.services.jobs.history({ event: 'recycled' });
  expect(history.items[0]).toMatchObject({ path: s.source, jobId: s.jobId, data: { recycleBinEntryId: entry.id } });
});

test('recycleForReplace - a second entry for the same file in the same second gets its own folder', async () => {
  const s = setup();
  t = s.t;
  const refs = { jobId: s.jobId, mediaFileId: s.mediaFileId };
  const first = await t.ctx.services.recycleBin.recycleForReplace(s.source, refs);
  const second = await t.ctx.services.recycleBin.recycleForReplace(s.source, refs);
  expect(second.entry.recyclePath).not.toBe(first.entry.recyclePath);
});

test('recycleForReplace - uses the configured bin path and the retention setting', async () => {
  const s = setup();
  t = s.t;
  const bin = join(t.dir, 'recycle');
  t.ctx.settings.update({ recycleBin: { path: bin, retentionDays: 2 } });

  const { entry } = await t.ctx.services.recycleBin.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null });

  expect(entry.recyclePath.startsWith(`${bin}/`)).toBe(true);
  expect(Date.parse(entry.expiresAt) - Date.parse(entry.createdAt)).toBeLessThan(2.1 * 86_400_000);
});

test('recycleForReplace - falls back to a bin next to the file when the library root is unknown', async () => {
  const s = setup({ rootKnown: false });
  t = s.t;
  const { entry } = await t.ctx.services.recycleBin.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null });
  expect(entry.recyclePath.startsWith(join(dirname(s.source), '.wololo-recycle'))).toBe(true);
});

test('recycle - moves the file into the bin', async () => {
  const s = setup();
  t = s.t;
  const entry = await t.ctx.services.recycleBin.recycle(s.source, { mediaFileId: s.mediaFileId });
  expect(existsSync(s.source)).toBe(false);
  expect(readFileSync(entry.recyclePath, 'utf8')).toBe('original');
  await expectAppError(t.ctx.services.recycleBin.recycle(s.source, {}), 'not_found');
});

test('restore - puts the original back, bins the converted file, ignores the row, notifies and records history', async () => {
  const s = setup();
  t = s.t;
  const { entry } = await t.ctx.services.recycleBin.recycleForReplace(s.source, {
    jobId: s.jobId,
    mediaFileId: s.mediaFileId,
  });
  const temp = join(dirname(s.source), 'Movie (2020).wololo-tmp.mkv');
  writeFileSync(temp, 'converted');
  renameSync(temp, s.source);

  const restored = await t.ctx.services.recycleBin.restore(entry.id);

  expect(restored.restoredAt).not.toBeNull();
  expect(readFileSync(s.source, 'utf8')).toBe('original');
  const active = await t.ctx.services.recycleBin.list({});
  expect(active.total).toBe(1);
  expect(readFileSync(active.items[0]?.recyclePath ?? '', 'utf8')).toBe('converted');
  expect(s.recorder.ignored).toEqual([{ id: s.mediaFileId, ignored: true, reason: 'restored from recycle bin' }]);
  expect(s.recorder.reprobed).toEqual([{ id: s.mediaFileId, status: 'ignored', path: s.source }]);
  expect(s.notified).toEqual([
    { kind: 'replaced', localPath: s.source, mediaFileId: s.mediaFileId, arr: null, jobId: s.jobId },
  ]);
  expect((await t.ctx.services.jobs.history({ event: 'restored' })).total).toBe(1);
  await expectAppError(t.ctx.services.recycleBin.restore(entry.id), 'conflict');
});

test('restore - a converted file at a new path (mp4 -> mkv) is binned too', async () => {
  const s = setup();
  t = s.t;
  const mp4 = join(dirname(s.source), 'Old.mp4');
  writeFileSync(mp4, 'mp4 original');
  const entry = await t.ctx.services.recycleBin.recycle(mp4, { mediaFileId: s.mediaFileId });

  await t.ctx.services.recycleBin.restore(entry.id);

  expect(readFileSync(mp4, 'utf8')).toBe('mp4 original');
  expect(existsSync(s.source)).toBe(false);
  expect(readdirSync(dirname(s.source))).toEqual(['Old.mp4']);
  expect(s.recorder.ignored).toHaveLength(1);
  expect(s.recorder.reprobed).toEqual([]);
});

test('restore - an mp4 converted to mkv moves the media row back to the mp4 path and ignores it', async () => {
  const s = setup();
  t = s.t;
  const mp4 = join(dirname(s.source), 'Movie (2020).mp4');
  renameSync(s.source, mp4);
  s.recorder.files.set(s.mediaFileId, mediaDetail(s.mediaFileId, mp4));
  const { entry } = await t.ctx.services.recycleBin.recycleForReplace(mp4, {
    jobId: s.jobId,
    mediaFileId: s.mediaFileId,
  });
  unlinkSync(mp4);
  writeFileSync(s.source, 'converted');
  await s.recorder.service.recordJobResult(s.mediaFileId, {
    status: 'compatible',
    reason: null,
    lastJobId: s.jobId,
    path: s.source,
  });

  await t.ctx.services.recycleBin.restore(entry.id);

  expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mp4']);
  expect(s.recorder.results.at(-1)).toEqual({
    id: s.mediaFileId,
    update: { status: 'ignored', reason: 'restored from recycle bin', lastJobId: s.jobId, path: mp4 },
  });
  expect(s.recorder.files.get(s.mediaFileId)).toMatchObject({ path: mp4, status: 'ignored' });
  expect(s.recorder.ignored).toEqual([{ id: s.mediaFileId, ignored: true, reason: 'restored from recycle bin' }]);
  expect(s.recorder.reprobed).toEqual([{ id: s.mediaFileId, status: 'ignored', path: mp4 }]);
});

test('recycleForReplace - falls back to moving the original when the filesystem refuses hard links', async () => {
  const s = setup();
  t = s.t;
  const service = createRecycleBinService(t.ctx, {
    link: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
  });

  const { entry, mode } = await service.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: s.mediaFileId });

  expect(mode).toBe('move');
  expect(existsSync(s.source)).toBe(false);
  expect(readFileSync(entry.recyclePath, 'utf8')).toBe('original');
  expect(getJobRow(t.ctx.db, s.jobId)?.recycleBinEntryId).toBe(entry.id);
});

test('recycleForReplace - other link errors are not mistaken for missing hard-link support', async () => {
  const s = setup();
  t = s.t;
  const service = createRecycleBinService(t.ctx, {
    link: () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
  });

  await expect(service.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null })).rejects.toThrow('disk full');
  expect(readFileSync(s.source, 'utf8')).toBe('original');
});

test('recycleForReplace - expiry follows the injected clock', async () => {
  const s = setup();
  t = s.t;
  const service = createRecycleBinService(t.ctx, { now: () => new Date('2026-11-15T10:30:00.000Z') });

  const { entry } = await service.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null });

  expect(entry.expiresAt).toBe('2026-11-22T10:30:00.000Z');
  expect(entry.recyclePath).toContain('/20261115T103000Z/');
});

test.skipIf(process.getuid?.() === 0)(
  'recycleForReplace - a bin path that cannot be written fails before touching the original',
  async () => {
    const s = setup();
    t = s.t;
    const locked = join(t.dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    t.ctx.settings.update({ recycleBin: { path: join(locked, 'bin') } });
    try {
      await expectAppError(
        t.ctx.services.recycleBin.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null }),
        'precondition_failed',
      );
      expect(readFileSync(s.source, 'utf8')).toBe('original');
    } finally {
      chmodSync(locked, 0o700);
    }
  },
);

test('restore - fails cleanly when the recycled file is gone', async () => {
  const s = setup();
  t = s.t;
  const entry = await t.ctx.services.recycleBin.recycle(s.source, {});
  unlinkSync(entry.recyclePath);
  await expectAppError(t.ctx.services.recycleBin.restore(entry.id), 'conflict');
  await expectAppError(t.ctx.services.recycleBin.restore(999), 'not_found');
});

test('recycle bin - rejects a stored row whose recyclePath is outside a recycle stamp folder', async () => {
  const s = setup();
  t = s.t;
  const entry = await t.ctx.services.recycleBin.recycle(s.source, {});
  const outside = join(t.dir, 'secret.txt');
  writeFileSync(outside, 'secret');
  t.ctx.db.update(recycleBin).set({ recyclePath: outside }).where(eq(recycleBin.id, entry.id)).run();
  expect(existsSync(outside)).toBe(true);

  await expectAppError(t.ctx.services.recycleBin.restore(entry.id), 'conflict');
  await expectAppError(t.ctx.services.recycleBin.remove(entry.id), 'conflict');
  await t.ctx.services.recycleBin.purge({ all: true });

  expect(readFileSync(outside, 'utf8')).toBe('secret');
  expect(existsSync(s.source)).toBe(false);
});

test('restore - rejects a stored originalPath that is not absolute and normalized', async () => {
  const s = setup();
  t = s.t;
  const entry = await t.ctx.services.recycleBin.recycle(s.source, {});
  t.ctx.db
    .update(recycleBin)
    .set({ originalPath: `${s.root}/x/../escaped.mkv` })
    .where(eq(recycleBin.id, entry.id))
    .run();

  await expectAppError(t.ctx.services.recycleBin.restore(entry.id), 'conflict');

  expect(existsSync(entry.recyclePath)).toBe(true);
});

test('remove - deletes the file and its empty folders, keeps the bin root', async () => {
  const s = setup();
  t = s.t;
  const entry = await t.ctx.services.recycleBin.recycle(s.source, {});

  await t.ctx.services.recycleBin.remove(entry.id);

  expect(existsSync(entry.recyclePath)).toBe(false);
  expect(readdirSync(join(s.root, '.wololo-recycle'))).toEqual([]);
  expect(getRecycleRow(t.ctx.db, entry.id)?.purgedAt).not.toBeNull();
  expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
  await expectAppError(t.ctx.services.recycleBin.remove(entry.id), 'conflict');
});

test('purge - removes only expired entries unless all is set, and reports freed bytes', async () => {
  const s = setup();
  t = s.t;
  t.ctx.settings.update({ recycleBin: { retentionDays: 0 } });
  const expired = await t.ctx.services.recycleBin.recycle(s.source, {});
  t.ctx.settings.update({ recycleBin: { retentionDays: 7 } });
  const other = join(dirname(s.source), 'Other.mkv');
  writeFileSync(other, '12345');
  const kept = await t.ctx.services.recycleBin.recycle(other, {});

  expect(await t.ctx.services.recycleBin.purge({})).toEqual({ purged: 1, freedBytes: 8 });
  expect(existsSync(expired.recyclePath)).toBe(false);
  expect(existsSync(kept.recyclePath)).toBe(true);
  expect(await t.ctx.services.recycleBin.purge({ all: true })).toEqual({ purged: 1, freedBytes: 5 });
  expect(await t.ctx.services.recycleBin.purge({ all: true })).toEqual({ purged: 0, freedBytes: 0 });
});

test('list - paginates active entries, newest first', async () => {
  const s = setup();
  t = s.t;
  const first = await t.ctx.services.recycleBin.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null });
  const second = await t.ctx.services.recycleBin.recycleForReplace(s.source, { jobId: s.jobId, mediaFileId: null });

  const page = await t.ctx.services.recycleBin.list({ pageSize: 1 });

  expect(page).toMatchObject({ page: 1, pageSize: 1, total: 2 });
  expect(page.items.map((item) => item.id)).toEqual([second.entry.id]);
  expect((await t.ctx.services.recycleBin.list({ sortDir: 'asc' })).items[0]?.id).toBe(first.entry.id);
});
