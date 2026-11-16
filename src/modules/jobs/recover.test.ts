import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { createFakeRunContext } from '../../../test/helpers/run-context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { FileChangedEvent } from '../../contracts/integrations.ts';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import type { JobRow, NewJobRow } from '../../db/schema.ts';
import { createRecycleBinService } from '../recycle-bin/index.ts';
import { getRecycleRow, insertRecycleRow } from '../recycle-bin/recycleBinQueries.ts';
import { createAudioExecutor } from './audioExecutor.ts';
import { getJobRow, updateJobRow } from './jobQueries.ts';
import { tempPathFor } from './paths.ts';
import { NODE_REPLACE_FS } from './replace.ts';
import {
  ffprobeResult,
  type MediaRecorder,
  mediaDetail,
  realMediaToolServices,
  recordingMediaService,
  sha256,
} from './test-support.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

interface Setup {
  t: TestContext;
  root: string;
  libraryId: number;
  recorder: MediaRecorder;
  notified: FileChangedEvent[];
  seedJob(path: string, overrides: Partial<NewJobRow>): JobRow;
}

function setup(): Setup {
  const holder = { root: '' };
  const notified: FileChangedEvent[] = [];
  const { service, recorder } = recordingMediaService([]);
  const tools = realMediaToolServices({ notified });
  const context = createTestContext({
    overrides: {
      ...tools,
      media: service,
      libraries: stubService<LibraryService>('libraries', {
        get: tools.libraries.get,
        list: async () => [
          {
            ...(await tools.libraries.get(1)),
            roots: [{ id: 1, path: holder.root, freeBytes: null, accessible: true }],
          },
        ],
        findRootForPath: async () => ({ library: await tools.libraries.get(1), rootId: 1, rootPath: holder.root }),
      }),
    },
  });
  holder.root = join(context.dir, 'movies');
  mkdirSync(holder.root, { recursive: true });
  const library = insertLibrary(context.ctx.db, { roots: [holder.root] });
  return {
    t: context,
    root: holder.root,
    libraryId: library.libraryId,
    recorder,
    notified,
    seedJob: (path, overrides) => {
      const media = insertMediaFile(context.ctx.db, library, { path });
      recorder.files.set(media.id, mediaDetail(media.id, path, { libraryId: library.libraryId }));
      return insertJob(context.ctx.db, {
        sourcePath: path,
        mediaFileId: media.id,
        libraryId: library.libraryId,
        state: 'running',
        attempts: 1,
        ...overrides,
      });
    },
  };
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe.skipIf(!ffmpegAvailable())('crash during the replace step of a real audio job', () => {
  async function runUntilCrash(
    s: Setup,
    crashAt: 'rename' | 'clear_temp_path' | 'notifying',
    options: { binMode?: 'link' | 'move' } = {},
  ) {
    const source = await ensureFixtureCopy(FIXTURES.dts51, join(s.root, 'Movie (2020)'), 'Movie (2020).mkv');
    const row = s.seedJob(source, { step: 'preparing' });
    const run = createFakeRunContext({ job: { id: row.id, sourcePath: source, mediaFileId: row.mediaFileId } });
    run.setStep = (step) => {
      updateJobRow(s.t.ctx.db, row.id, { step });
      if (step === 'notifying' && crashAt === 'notifying') throw new Error('simulated power loss while notifying');
    };
    const recycleBin =
      options.binMode === 'move'
        ? createRecycleBinService(s.t.ctx, {
            link: () => {
              throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            },
          })
        : s.t.ctx.services.recycleBin;
    run.setTempPath = async (path) => {
      if (path === null && crashAt === 'clear_temp_path') throw new Error('simulated power loss after rename');
      updateJobRow(s.t.ctx.db, row.id, { tempPath: path });
    };
    const executor = createAudioExecutor({
      services: { ...s.t.ctx.services, recycleBin },
      ffmpegPath: () => 'ffmpeg',
      recycleBinEnabled: () => true,
      checkRecycleBin: async () => {},
      recordPlan: () => {},
      log: s.t.ctx.logs.logger('test'),
      fs: {
        ...NODE_REPLACE_FS,
        rename: (from, to) => {
          if (crashAt === 'rename' && from.includes(TEMP_FILE_MARKER))
            throw new Error('simulated power loss before rename');
          NODE_REPLACE_FS.rename(from, to);
        },
      },
    });
    const originalHash = await sha256(source);
    await expect(executor(run)).rejects.toThrow('simulated power loss');
    return { source, row, originalHash };
  }

  test('recover - crash before the rename keeps the original and re-queues', async () => {
    const s = setup();
    t = s.t;
    const { source, row, originalHash } = await runUntilCrash(s, 'rename');
    const crashed = getJobRow(t.ctx.db, row.id);
    expect(crashed?.step).toBe('replacing');
    expect(existsSync(tempPathFor(source))).toBe(true);
    const bin = await t.ctx.services.recycleBin.list({});
    expect(bin.total).toBe(1);
    expect(crashed?.recycleBinEntryId).toBe(bin.items[0]?.id ?? -1);

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 1 });

    expect(await sha256(source)).toBe(originalHash);
    expect(readdirSync(dirname(source))).toEqual(['Movie (2020).mkv']);
    expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
    expect(existsSync(bin.items[0]?.recyclePath ?? '')).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({
      state: 'queued',
      step: 'waiting',
      trigger: 'recovery',
      tempPath: null,
      recycleBinEntryId: null,
    });
    expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['needs_work']);
  }, 60_000);

  test('recover - crash right after the rename completes the job and keeps the bin entry', async () => {
    const s = setup();
    t = s.t;
    const { source, row, originalHash } = await runUntilCrash(s, 'clear_temp_path');
    expect(existsSync(tempPathFor(source))).toBe(false);

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    const audio = (await ffprobeResult(source)).streams.filter((stream) => stream.kind === 'audio');
    expect(audio.map((stream) => stream.codec)).toEqual(['ac3']);
    const bin = await t.ctx.services.recycleBin.list({});
    expect(bin.total).toBe(1);
    expect(await sha256(bin.items[0]?.recyclePath ?? '')).toBe(originalHash);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({
      state: 'completed',
      step: 'done',
      tempPath: null,
      outputPath: source,
    });
    expect(s.recorder.results.map((entry) => entry.update.status)).toEqual(['compatible']);
    const history = await t.ctx.services.jobs.history({ jobId: row.id });
    expect(history.items[0]).toMatchObject({ event: 'completed', message: 'completed during crash recovery' });
  }, 60_000);

  test('recover - crash while notifying completes the job and sends the notification it missed', async () => {
    const s = setup();
    t = s.t;
    const { source, row, originalHash } = await runUntilCrash(s, 'notifying');
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ step: 'notifying', tempPath: null });
    expect(s.notified).toEqual([]);

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    const audio = (await ffprobeResult(source)).streams.filter((stream) => stream.kind === 'audio');
    expect(audio.map((stream) => stream.codec)).toEqual(['ac3']);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'completed', outputPath: source });
    expect(s.recorder.results.map((entry) => entry.update.status)).toEqual(['compatible']);
    expect(s.notified.map((event) => [event.kind, event.localPath])).toEqual([['replaced', source]]);
    const bin = await t.ctx.services.recycleBin.list({});
    expect(await sha256(bin.items[0]?.recyclePath ?? '')).toBe(originalHash);
    expect((await t.ctx.services.jobs.history({ jobId: row.id })).items[0]?.event).toBe('completed');
  }, 60_000);

  test('recover - crash before the rename with the bin in move mode puts the verified file in place', async () => {
    const s = setup();
    t = s.t;
    const { source, row, originalHash } = await runUntilCrash(s, 'rename', { binMode: 'move' });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(tempPathFor(source))).toBe(true);

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    const audio = (await ffprobeResult(source)).streams.filter((stream) => stream.kind === 'audio');
    expect(audio.map((stream) => stream.codec)).toEqual(['ac3']);
    expect(readdirSync(dirname(source))).toEqual(['Movie (2020).mkv']);
    const bin = await t.ctx.services.recycleBin.list({});
    expect(bin.total).toBe(1);
    expect(await sha256(bin.items[0]?.recyclePath ?? '')).toBe(originalHash);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'completed', tempPath: null });
  }, 60_000);
});

describe('crash recovery decisions on seeded state', () => {
  test('recover - original moved into the bin (no hard links) gets the verified temp file renamed into place', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'A', 'A.mkv');
    const temp = write(tempPathFor(source), 'converted');
    const recyclePath = write(join(s.root, '.wololo-recycle', '20261115T000000Z', 'A', 'A.mkv'), 'original');
    const entry = insertRecycleRow(t.ctx.db, {
      originalPath: source,
      recyclePath,
      sizeBytes: 8,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const row = s.seedJob(source, { step: 'replacing', tempPath: temp, recycleBinEntryId: entry.id });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    expect(readFileSync(source, 'utf8')).toBe('converted');
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(recyclePath, 'utf8')).toBe('original');
    expect(getJobRow(t.ctx.db, row.id)?.state).toBe('completed');
  });

  test('recover - neither file in the library restores the original from the bin and re-queues', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'B', 'B.mkv');
    mkdirSync(dirname(source), { recursive: true });
    const recyclePath = write(join(s.root, '.wololo-recycle', '20261115T000000Z', 'B', 'B.mkv'), 'original');
    const entry = insertRecycleRow(t.ctx.db, {
      originalPath: source,
      recyclePath,
      sizeBytes: 8,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const row = s.seedJob(source, { step: 'replacing', tempPath: tempPathFor(source), recycleBinEntryId: entry.id });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 0 });

    expect(readFileSync(source, 'utf8')).toBe('original');
    expect(existsSync(recyclePath)).toBe(false);
    expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
    expect(getJobRow(t.ctx.db, row.id)?.state).toBe('queued');
  });

  test('recover - neither file nor a bin entry fails the job', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'C', 'C.mkv');
    const row = s.seedJob(source, { step: 'replacing', tempPath: tempPathFor(source) });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 0 });

    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({
      state: 'failed',
      error: 'source file missing after an interrupted replace',
    });
    expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['failed']);
  });

  test('recover - a source deleted by someone else fails the job and deletes the verified temp file', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'E', 'E.mkv');
    const temp = write(tempPathFor(source), 'converted');
    const row = s.seedJob(source, { step: 'replacing', tempPath: temp });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 1 });

    expect(existsSync(source)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)?.state).toBe('failed');
    expect(s.notified).toEqual([]);
  });

  test('recover - a bin row whose move never happened is dropped and the original kept', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'F', 'F.mkv'), 'original');
    const temp = write(tempPathFor(source), 'converted');
    const entry = insertRecycleRow(t.ctx.db, {
      originalPath: source,
      recyclePath: join(s.root, '.wololo-recycle', '20261115T000000Z', 'F', 'F.mkv'),
      sizeBytes: 8,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const row = s.seedJob(source, { step: 'replacing', tempPath: temp, recycleBinEntryId: entry.id });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 1 });

    expect(readFileSync(source, 'utf8')).toBe('original');
    expect(getRecycleRow(t.ctx.db, entry.id)).toBeUndefined();
    expect(getJobRow(t.ctx.db, row.id)?.recycleBinEntryId).toBeNull();
  });

  test('recover - an mp4 source left next to its finished mkv output is removed', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'D', 'D.mp4'), 'old mp4');
    const output = write(join(s.root, 'D', 'D.mkv'), 'new mkv');
    const row = s.seedJob(source, { step: 'replacing', tempPath: tempPathFor(source) });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(output, 'utf8')).toBe('new mkv');
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'completed', outputPath: output });
  });

  test('recover - an mp4 job interrupted while notifying completes and moves the media row to the mkv', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'N', 'N.mp4');
    const output = write(join(s.root, 'N', 'N.mkv'), 'new mkv');
    const row = s.seedJob(source, { step: 'notifying', tempPath: null });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'completed', outputPath: output });
    expect(s.recorder.results).toHaveLength(1);
    expect(s.recorder.results[0]?.update).toMatchObject({ status: 'compatible', lastJobId: row.id, path: output });
    expect(s.notified.map((event) => event.localPath)).toEqual([output]);
    expect(s.recorder.statuses).toEqual([]);
  });

  test('recover - an mp4 temp file hard-linked to its output but not yet unlinked completes the swap', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'L', 'L.mp4'), 'old mp4');
    const temp = write(tempPathFor(source), 'new mkv');
    const output = join(s.root, 'L', 'L.mkv');
    linkSync(temp, output);
    const row = s.seedJob(source, { step: 'replacing', tempPath: temp });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 1, tempFilesDeleted: 0 });

    expect(readdirSync(dirname(source))).toEqual(['L.mkv']);
    expect(readFileSync(output, 'utf8')).toBe('new mkv');
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'completed', outputPath: output });
  });

  test('recover - a foreign file at the mp4 output path is never overwritten by the temp file', async () => {
    const s = setup();
    t = s.t;
    const source = join(s.root, 'K', 'K.mp4');
    const temp = write(tempPathFor(source), 'converted');
    const foreign = write(join(s.root, 'K', 'K.mkv'), 'someone else');
    const recyclePath = write(join(s.root, '.wololo-recycle', '20261115T000000Z', 'K', 'K.mp4'), 'old mp4');
    const entry = insertRecycleRow(t.ctx.db, {
      originalPath: source,
      recyclePath,
      sizeBytes: 7,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const row = s.seedJob(source, { step: 'replacing', tempPath: temp, recycleBinEntryId: entry.id });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 1 });

    expect(readFileSync(foreign, 'utf8')).toBe('someone else');
    expect(readFileSync(source, 'utf8')).toBe('old mp4');
    expect(existsSync(temp)).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)?.state).toBe('queued');
  });

  test('recover - a job interrupted while encoding loses its temp file and is re-queued', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'E', 'E.mkv'), 'original');
    const temp = write(tempPathFor(source), 'partial');
    const row = s.seedJob(source, { step: 'encoding', tempPath: temp });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 1 });

    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe('original');
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'queued', trigger: 'recovery', tempPath: null });
  });

  test('recover - a job interrupted maxAttempts times is failed instead of re-queued', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'F', 'F.mkv'), 'original');
    const temp = write(tempPathFor(source), 'partial');
    const row = s.seedJob(source, { step: 'encoding', tempPath: temp, attempts: 3 });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 1 });

    expect(existsSync(temp)).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({
      state: 'failed',
      error: 'interrupted 3 times, not retrying automatically',
    });
  });

  test('recover - a bdmv temp directory is deleted recursively', async () => {
    const s = setup();
    t = s.t;
    const tempDir = join(s.root, '.wololo-tmp-9');
    write(join(tempDir, 'audio', 'track1.mka'), 'side file');
    const row = s.seedJob(join(s.root, 'Disc'), { type: 'bdmv', step: 'muxing', tempPath: `${tempDir}/` });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 1 });

    expect(existsSync(tempDir)).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)?.state).toBe('queued');
  });

  test('recover - a temp path without the marker is never deleted', async () => {
    const s = setup();
    t = s.t;
    const precious = write(join(s.root, 'G', 'precious.mkv'), 'keep me');
    s.seedJob(join(s.root, 'G', 'G.mkv'), { step: 'encoding', tempPath: precious });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 0 });

    expect(readFileSync(precious, 'utf8')).toBe('keep me');
  });

  test('recover - stale temp files of finished jobs are deleted', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'H', 'H.mkv'), 'original');
    const temp = write(tempPathFor(source), 'stale');
    const row = s.seedJob(source, { state: 'failed', step: 'encoding', tempPath: temp });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 1 });

    expect(existsSync(temp)).toBe(false);
    expect(getJobRow(t.ctx.db, row.id)).toMatchObject({ state: 'failed', tempPath: null });
  });

  test.skipIf(process.getuid?.() === 0)(
    'recover - an undeletable stale temp file is logged and does not block startup',
    async () => {
      const s = setup();
      t = s.t;
      const source = write(join(s.root, 'R', 'R.mkv'), 'original');
      const temp = write(tempPathFor(source), 'stale');
      const row = s.seedJob(source, { state: 'failed', step: 'replacing', tempPath: temp });
      const queued = s.seedJob(write(join(s.root, 'Q', 'Q.mkv'), 'q'), { state: 'running', step: 'encoding' });
      chmodSync(dirname(temp), 0o500);
      try {
        expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 1, completed: 0, tempFilesDeleted: 0 });
        expect(existsSync(temp)).toBe(true);
        expect(getJobRow(t.ctx.db, row.id)?.tempPath).toBe(temp);
        expect(getJobRow(t.ctx.db, queued.id)?.state).toBe('queued');
        const warnings = t.ctx.logs.entries().filter((entry) => entry.message === 'cannot delete temp path');
        expect(warnings).toHaveLength(1);
      } finally {
        chmodSync(dirname(temp), 0o700);
      }
    },
  );

  test('recover - orphaned temp directories at a library root are deleted, nested temp files are left to housekeeping', async () => {
    const s = setup();
    t = s.t;
    const orphanDir = join(s.root, '.wololo-tmp-404');
    write(join(orphanDir, 'side.mka'), 'side file');
    const nested = write(join(s.root, 'O', 'O.wololo-tmp.mkv'), 'orphan');
    const kept = write(join(s.root, 'O', 'O.mkv'), 'original');

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 1 });
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(nested)).toBe(true);

    expect(await t.ctx.services.jobs.housekeeping()).toBe(
      'deleted 1 temp file(s), 0 old job(s), 0 history entr(ies) and 0 job log(s)',
    );
    expect(existsSync(nested)).toBe(false);
    expect(readFileSync(kept, 'utf8')).toBe('original');
  });

  test('housekeeping - temp files of running jobs and the recycle bin are left alone', async () => {
    const s = setup();
    t = s.t;
    const source = write(join(s.root, 'P', 'P.mkv'), 'original');
    const temp = write(tempPathFor(source), 'being written');
    s.seedJob(source, { step: 'encoding', tempPath: temp });
    const binned = write(join(s.root, '.wololo-recycle', '20261115T000000Z', 'x.wololo-tmp.mkv'), 'odd but binned');

    expect(await t.ctx.services.jobs.housekeeping()).toBe(
      'deleted 0 temp file(s), 0 old job(s), 0 history entr(ies) and 0 job log(s)',
    );

    expect(existsSync(temp)).toBe(true);
    expect(existsSync(binned)).toBe(true);
  });

  test('recover - nothing to do on a clean start', async () => {
    const s = setup();
    t = s.t;
    s.seedJob(join(s.root, 'I.mkv'), { state: 'queued', attempts: 0 });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 0 });
  });
});
