import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { createFakeRunContext } from '../../../test/helpers/run-context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import type { JobRow, NewJobRow } from '../../db/schema.ts';
import { insertRecycleRow } from '../recycle-bin/recycleBinQueries.ts';
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
  seedJob(path: string, overrides: Partial<NewJobRow>): JobRow;
}

function setup(): Setup {
  const holder = { root: '' };
  const { service, recorder } = recordingMediaService([]);
  const tools = realMediaToolServices();
  const context = createTestContext({
    overrides: {
      ...tools,
      media: service,
      libraries: stubService<LibraryService>('libraries', {
        get: tools.libraries.get,
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
  async function runUntilCrash(s: Setup, crashAt: 'rename' | 'clear_temp_path') {
    const source = await ensureFixtureCopy(FIXTURES.dts51, join(s.root, 'Movie (2020)'), 'Movie (2020).mkv');
    const row = s.seedJob(source, { step: 'preparing' });
    const run = createFakeRunContext({ job: { id: row.id, sourcePath: source, mediaFileId: row.mediaFileId } });
    run.setStep = (step) => {
      updateJobRow(s.t.ctx.db, row.id, { step });
    };
    run.setTempPath = async (path) => {
      if (path === null && crashAt === 'clear_temp_path') throw new Error('simulated power loss after rename');
      updateJobRow(s.t.ctx.db, row.id, { tempPath: path });
    };
    const executor = createAudioExecutor({
      services: s.t.ctx.services,
      ffmpegPath: () => 'ffmpeg',
      recycleBinEnabled: () => true,
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

  test('recover - nothing to do on a clean start', async () => {
    const s = setup();
    t = s.t;
    s.seedJob(join(s.root, 'I.mkv'), { state: 'queued', attempts: 0 });

    expect(await t.ctx.services.jobs.recover()).toEqual({ requeued: 0, completed: 0, tempFilesDeleted: 0 });
  });
});
