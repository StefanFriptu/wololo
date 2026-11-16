import { afterEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob, insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { BdmvService } from '../../contracts/bdmv.ts';
import type { PlexService } from '../../contracts/integrations.ts';
import type { JobExecutor, JobOutcome } from '../../contracts/jobs.ts';
import { AppError, type ErrorCode } from '../../core/errors.ts';
import type { MediaFileDetail } from '../../shared/api-types.ts';
import type { BdmvJobPlan, ConversionPlan, MediaFileStatus, QueueState } from '../../shared/domain.ts';
import type { DeepPartial, Settings } from '../../shared/settings.ts';
import { createJobsService } from './index.ts';
import { getJobRow, updateJobRow } from './jobQueries.ts';
import { type MediaRecorder, mediaDetail, recordingMediaService, waitForEvent } from './test-support.ts';

const OUTCOME: JobOutcome = {
  outputPath: '/out/Movie (2020).mkv',
  after: null,
  lostFeatures: [],
  verification: { passed: true, checks: [] },
  bytesAfter: 10,
  recycleBinEntryId: null,
  message: 'done',
};

interface Gate {
  execute: JobExecutor;
  started: number[];
  release(jobId: number, error?: Error): void;
  waitStarted(count: number): Promise<void>;
}

function gatedExecutor(): Gate {
  const started: number[] = [];
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    started,
    execute: (run) =>
      new Promise<JobOutcome>((resolve, reject) => {
        started.push(run.job.id);
        run.signal.addEventListener('abort', () => reject(new Error('aborted')));
        pending.set(run.job.id, { resolve: () => resolve(OUTCOME), reject });
        for (const waiter of waiters.filter((w) => started.length >= w.count)) waiter.resolve();
      }),
    release: (jobId, error) => {
      const entry = pending.get(jobId);
      if (!entry) throw new Error(`job ${jobId} is not running`);
      if (error) entry.reject(error);
      else entry.resolve();
    },
    waitStarted: (count) =>
      started.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve })),
  };
}

interface Setup {
  t: TestContext;
  gate: Gate;
  recorder: MediaRecorder;
  addFile(status?: MediaFileStatus, kind?: 'file' | 'bdmv'): number;
}

const DISC_PLAN = { sourceKind: 'bdmv' } as BdmvJobPlan;

function setup(
  options: { settings?: DeepPartial<Settings>; plex?: PlexService; evaluatePlan?: BdmvJobPlan | null } = {},
): Setup {
  const gate = gatedExecutor();
  const { service, recorder } = recordingMediaService([]);
  const context = createTestContext({
    settings: { processing: { enabled: true } },
    overrides: {
      media: service,
      bdmv: stubService<BdmvService>('bdmv', {
        execute: gate.execute,
        evaluate: async () => ({
          status: 'needs_work',
          reason: options.evaluatePlan === null ? 'decision required' : null,
          plan: options.evaluatePlan === undefined ? DISC_PLAN : options.evaluatePlan,
          decisionId: null,
        }),
      }),
      plex: options.plex ?? stubService<PlexService>('plex', {}),
    },
  });
  if (options.settings) context.ctx.settings.update(options.settings);
  const library = insertLibrary(context.ctx.db, { roots: [join(context.dir, 'movies')] });
  let counter = 0;
  return {
    t: context,
    gate,
    recorder,
    addFile: (status = 'needs_work', kind = 'bdmv') => {
      counter += 1;
      const path = join(context.dir, 'movies', `Movie ${counter}`, kind === 'bdmv' ? '' : `Movie ${counter}.mkv`);
      const row = insertMediaFile(context.ctx.db, { libraryId: library.libraryId, rootIds: library.rootIds }, { path });
      recorder.files.set(row.id, mediaDetail(row.id, path, { libraryId: library.libraryId, status, kind }));
      return row.id;
    },
  };
}

const enqueueDisc = (s: Setup, mediaFileId: number, priority = 0) =>
  s.t.ctx.services.jobs.enqueue({ type: 'bdmv', trigger: 'manual', mediaFileId, priority, bdmvPlan: DISC_PLAN });

let t: TestContext | null = null;
afterEach(async () => {
  await t?.ctx.services.jobs.stop();
  t?.cleanup();
  t = null;
});

async function expectAppError(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

test('enqueue - is idempotent per media file while a job is queued or running', async () => {
  const s = setup();
  t = s.t;
  const id = s.addFile();
  const events: number[] = [];
  t.ctx.events.on('job.queued', ({ job }) => events.push(job.id));

  const first = await enqueueDisc(s, id);
  const second = await enqueueDisc(s, id);

  expect(second.id).toBe(first.id);
  expect(events).toEqual([first.id]);
  expect(first).toMatchObject({ state: 'queued', step: 'waiting', type: 'bdmv', title: `Movie 1`, mediaFileId: id });
  expect((await t.ctx.services.jobs.history({ jobId: first.id })).items.map((entry) => entry.event)).toEqual([
    'queued',
  ]);
});

test('enqueue - a finished job does not block a new one', async () => {
  const s = setup();
  t = s.t;
  const id = s.addFile();
  const first = await enqueueDisc(s, id);
  updateJobRow(t.ctx.db, first.id, { state: 'completed' });

  expect((await enqueueDisc(s, id)).id).not.toBe(first.id);
});

test('enqueueMany - refuses while processing is off (dry-run mode)', async () => {
  const s = setup({ settings: { processing: { enabled: false } } });
  t = s.t;
  await expectAppError(t.ctx.services.jobs.enqueueMany({ mediaFileIds: [1] }), 'precondition_failed');
});

test('enqueueMany - ids: queues needs_work rows, skips others with a reason, force overrides the status', async () => {
  const s = setup();
  t = s.t;
  const needsWork = s.addFile('needs_work', 'file');
  const compatible = s.addFile('compatible', 'file');
  const disc = s.addFile('needs_work', 'bdmv');

  const result = await t.ctx.services.jobs.enqueueMany({ mediaFileIds: [needsWork, compatible, disc, 999] });

  expect(result.jobs.map((job) => [job.mediaFileId, job.type])).toEqual([
    [needsWork, 'audio'],
    [disc, 'bdmv'],
  ]);
  expect(result.skipped).toEqual([
    { mediaFileId: compatible, reason: 'status is compatible' },
    { mediaFileId: 999, reason: 'not found' },
  ]);
  const forced = await t.ctx.services.jobs.enqueueMany({ mediaFileIds: [compatible], force: true, priority: 5 });
  expect(forced.jobs[0]).toMatchObject({ mediaFileId: compatible, priority: 5 });
  expect(getJobRow(t.ctx.db, result.jobs[1]?.id ?? 0)?.bdmvPlan).toEqual(DISC_PLAN);
});

test('enqueueMany - a disc without a plan is skipped with the evaluation reason', async () => {
  const s = setup({ evaluatePlan: null });
  t = s.t;
  const disc = s.addFile('needs_work', 'bdmv');
  expect(await t.ctx.services.jobs.enqueueMany({ mediaFileIds: [disc] })).toEqual({
    jobs: [],
    skipped: [{ mediaFileId: disc, reason: 'decision required' }],
  });
});

test('enqueueMany - a filter walks every page of needs_work rows', async () => {
  const s = setup();
  t = s.t;
  t.ctx.settings.update({ processing: { enabled: false } });
  for (let i = 0; i < 503; i++) s.addFile('needs_work', 'file');
  s.addFile('compatible', 'file');
  t.ctx.settings.update({ processing: { enabled: true } });
  await t.ctx.services.jobs.pause('user');

  const result = await t.ctx.services.jobs.enqueueMany({ filter: {} });

  expect(result.jobs).toHaveLength(503);
  expect(result.skipped).toEqual([]);
  expect(t.ctx.services.jobs.state().queued).toBe(503);
});

test('enqueueMany - a filter queues every row while the worker is running and rows leave needs_work', async () => {
  const s = setup();
  t = s.t;
  t.ctx.settings.update({ processing: { enabled: false } });
  const ids = Array.from({ length: 503 }, () => s.addFile('needs_work', 'bdmv'));
  t.ctx.settings.update({ processing: { enabled: true } });
  await t.ctx.services.jobs.start();

  const result = await t.ctx.services.jobs.enqueueMany({ filter: {} });

  await s.gate.waitStarted(1);
  expect(s.recorder.files.get(ids[0] ?? 0)?.status).toBe('processing');
  expect(result.skipped).toEqual([]);
  expect(result.jobs.map((job) => job.mediaFileId ?? 0).sort((a, b) => a - b)).toEqual(ids);
});

test('enqueueMany - lets the event loop run while queueing a large backlog', async () => {
  const s = setup();
  t = s.t;
  for (let i = 0; i < 300; i++) s.addFile('needs_work', 'file');
  let ranDuringQueueing = false;
  setImmediate(() => {
    ranDuringQueueing = true;
  });

  const response = await t.ctx.services.jobs.enqueueMany({ filter: {} });

  expect(ranDuringQueueing).toBe(true);
  expect(response.jobs).toHaveLength(300);
});

test('worker - runs one job at a time by default, highest priority first', async () => {
  const s = setup();
  t = s.t;
  const low = await enqueueDisc(s, s.addFile(), 0);
  const high = await enqueueDisc(s, s.addFile(), 10);
  const states: QueueState[] = [];
  t.ctx.events.on('queue.state', (state) => states.push(state));

  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);
  expect(s.gate.started).toEqual([high.id]);
  expect(t.ctx.services.jobs.state()).toMatchObject({ running: 1, queued: 1, concurrency: 1, paused: false });

  const firstDone = waitForEvent(t.ctx.events, 'job.finished', ({ job }) => job.id === high.id);
  s.gate.release(high.id);
  expect((await firstDone).state).toBe('completed');
  await s.gate.waitStarted(2);
  expect(s.gate.started).toEqual([high.id, low.id]);
  const secondDone = waitForEvent(t.ctx.events, 'job.finished', ({ job }) => job.id === low.id);
  s.gate.release(low.id);
  await secondDone;

  expect(states.some((state) => state.running === 1)).toBe(true);
  expect(states.every((state) => state.running <= 1)).toBe(true);
  expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'processing']);
  const detail = await t.ctx.services.jobs.get(high.id);
  expect(detail).toMatchObject({
    state: 'completed',
    step: 'done',
    progress: 1,
    outputPath: OUTCOME.outputPath,
    attempts: 1,
  });
  expect(detail.hasLog).toBe(true);
});

test('worker - honours a higher concurrency setting', async () => {
  const s = setup({ settings: { processing: { concurrency: 2 } } });
  t = s.t;
  const a = await enqueueDisc(s, s.addFile());
  const b = await enqueueDisc(s, s.addFile());
  await enqueueDisc(s, s.addFile());

  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(2);

  expect(s.gate.started).toEqual([a.id, b.id]);
  expect(t.ctx.services.jobs.state()).toMatchObject({ running: 2, queued: 1 });
});

test('worker - starts nothing while processing is disabled and picks up when it is enabled', async () => {
  const s = setup({ settings: { processing: { enabled: false } } });
  t = s.t;
  await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  expect(s.gate.started).toEqual([]);

  t.ctx.settings.update({ processing: { enabled: true } });
  await s.gate.waitStarted(1);
  expect(s.gate.started).toHaveLength(1);
});

test('worker - a user pause holds new jobs until resumed', async () => {
  const s = setup();
  t = s.t;
  expect(t.ctx.services.jobs.pause('user')).toMatchObject({ paused: true, pauseReasons: ['user'] });
  await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  expect(s.gate.started).toEqual([]);

  expect(t.ctx.services.jobs.resume('user').pauseReasons).toEqual([]);
  await s.gate.waitStarted(1);
});

test('worker - outside the processing window nothing starts', async () => {
  const hour = (offset: number) => `${String((new Date().getHours() + offset) % 24).padStart(2, '0')}:00`;
  const s = setup({ settings: { processing: { window: { enabled: true, start: hour(2), end: hour(3) } } } });
  t = s.t;
  await enqueueDisc(s, s.addFile());

  await t.ctx.services.jobs.start();

  expect(s.gate.started).toEqual([]);
  expect(t.ctx.services.jobs.state()).toMatchObject({ paused: true, pauseReasons: ['window'], queued: 1 });
  t.ctx.settings.update({ processing: { window: { enabled: false } } });
  await s.gate.waitStarted(1);
});

function streamingPlex(sessions: () => number): PlexService {
  return stubService<PlexService>('plex', {
    connection: async () => ({
      signedIn: true,
      username: 'u',
      serverName: 's',
      serverMachineId: 'm',
      serverUrl: 'http://plex',
      enabled: true,
      partialScan: true,
      pauseWhileStreaming: true,
    }),
    sessions: async () => ({ active: sessions(), sessions: [] }),
  });
}

test('worker - pauses while Plex is streaming and resumes when playback stops', async () => {
  let active = 1;
  const s = setup({ plex: streamingPlex(() => active) });
  t = s.t;
  await enqueueDisc(s, s.addFile());

  await t.ctx.services.jobs.start();

  expect(s.gate.started).toEqual([]);
  expect(t.ctx.services.jobs.state().pauseReasons).toEqual(['plex_streaming']);
  active = 0;
  t.ctx.settings.update({ processing: { freeSpaceMarginPercent: 6 } });
  await s.gate.waitStarted(1);
});

test('worker - streaming does not pause the queue while the Plex connection toggle is off', async () => {
  const plex = stubService<PlexService>('plex', {
    connection: async () => ({
      signedIn: true,
      username: 'u',
      serverName: 's',
      serverMachineId: 'm',
      serverUrl: 'http://plex',
      enabled: true,
      partialScan: true,
      pauseWhileStreaming: false,
    }),
    sessions: async () => ({ active: 2, sessions: [] }),
  });
  const s = setup({ plex });
  t = s.t;
  await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);
  expect(t.ctx.services.jobs.state().pauseReasons).toEqual([]);
});

test('worker - a running job is paused and re-queued when the processing window closes', async () => {
  const hour = (offset: number) => `${String((new Date().getHours() + offset) % 24).padStart(2, '0')}:00`;
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);
  const requeued = waitForEvent(t.ctx.events, 'job.queued');
  const idle = waitForEvent(t.ctx.events, 'queue.state', (state) => state.running === 0);

  t.ctx.settings.update({ processing: { window: { enabled: true, start: hour(2), end: hour(3) } } });

  expect((await requeued).job).toMatchObject({ id: job.id, state: 'queued' });
  expect(await idle).toMatchObject({ pauseReasons: ['window'], running: 0, queued: 1 });
  expect(getJobRow(t.ctx.db, job.id)).toMatchObject({ state: 'queued', attempts: 0 });
  const history = await t.ctx.services.jobs.history({ jobId: job.id });
  expect(history.items[0]?.message).toBe('paused while running (window)');
  expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'needs_work']);

  t.ctx.settings.update({ processing: { window: { enabled: false } } });
  await s.gate.waitStarted(2);
  expect(s.gate.started).toEqual([job.id, job.id]);
});

test('worker - a running job is paused when Plex playback starts and resumes after it stops', async () => {
  let active = 0;
  const s = setup({ plex: streamingPlex(() => active) });
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);
  const requeued = waitForEvent(t.ctx.events, 'job.queued');
  const idle = waitForEvent(t.ctx.events, 'queue.state', (state) => state.running === 0);

  active = 1;
  t.ctx.settings.update({ processing: { freeSpaceMarginPercent: 6 } });

  expect((await requeued).job).toMatchObject({ id: job.id, state: 'queued' });
  expect(await idle).toMatchObject({ pauseReasons: ['plex_streaming'], running: 0 });
  active = 0;
  t.ctx.settings.update({ processing: { freeSpaceMarginPercent: 7 } });
  await s.gate.waitStarted(2);
});

test('worker - a free-space shortage re-queues the job and holds the queue instead of failing every job', async () => {
  const s = setup();
  t = s.t;
  let runs = 0;
  t.ctx.services.bdmv.execute = async (run) => {
    runs += 1;
    await run.ensureFreeSpace(t?.dir ?? '/', Number.MAX_SAFE_INTEGER);
    return OUTCOME;
  };
  const jobs = [
    await enqueueDisc(s, s.addFile()),
    await enqueueDisc(s, s.addFile()),
    await enqueueDisc(s, s.addFile()),
  ];
  const requeued = waitForEvent(t.ctx.events, 'job.queued');

  await t.ctx.services.jobs.start();
  await requeued;
  await Bun.sleep(50);

  expect(runs).toBe(1);
  for (const job of jobs) expect(getJobRow(t.ctx.db, job.id)).toMatchObject({ state: 'queued', attempts: 0 });
  expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'needs_work']);
  expect((await t.ctx.services.jobs.history({ event: 'failed' })).total).toBe(0);

  t.ctx.settings.update({ processing: { freeSpaceMarginPercent: 0 } });
  await Bun.sleep(50);
  expect(runs).toBe(2);
});

test('worker - a completed bdmv job records retagged streams from the plan its executor applied', async () => {
  const s = setup();
  t = s.t;
  const applied = {
    streams: [{ kind: 'video' }, { kind: 'audio', language: 'spa', retagged: true }],
  } as ConversionPlan;
  t.ctx.services.bdmv.execute = async () => ({ ...OUTCOME, plan: applied });
  const job = await enqueueDisc(s, s.addFile());
  const finished = waitForEvent(t.ctx.events, 'job.finished');

  await t.ctx.services.jobs.start();

  expect((await finished).state).toBe('completed');
  const history = await t.ctx.services.jobs.history({ jobId: job.id, event: 'completed' });
  expect(history.items[0]?.data?.retagged).toEqual(['audio 1 -> spa']);
  expect((await t.ctx.services.jobs.get(job.id)).plan).toEqual(applied);
});

test('worker - an executor error fails the job and marks the media file failed', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);
  const finished = waitForEvent(t.ctx.events, 'job.finished');

  s.gate.release(job.id, new Error('mkvmerge exited with 2'));

  expect(await finished).toMatchObject({ state: 'failed', job: { error: 'mkvmerge exited with 2' } });
  expect(s.recorder.statuses.at(-1)).toMatchObject({ status: 'failed', reason: 'mkvmerge exited with 2' });
  const history = await t.ctx.services.jobs.history({ jobId: job.id, sortDir: 'asc' });
  expect(history.items.map((entry) => entry.event)).toEqual(['queued', 'started', 'failed']);
  expect(history.items[2]?.data).toEqual({ error: 'mkvmerge exited with 2' });
});

test('cancel - a queued job is cancelled immediately', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  expect(await t.ctx.services.jobs.cancel(job.id)).toMatchObject({ state: 'cancelled' });
  await expectAppError(t.ctx.services.jobs.cancel(job.id), 'conflict');
});

test('cancel - a running job is aborted and its file goes back to needs_work', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);

  expect(await t.ctx.services.jobs.cancel(job.id)).toMatchObject({ state: 'cancelled' });
  expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'needs_work']);
  expect(t.ctx.services.jobs.state().running).toBe(0);
});

test('retry - re-queues a failed job and rejects active ones', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await expectAppError(t.ctx.services.jobs.retry(job.id), 'conflict');
  updateJobRow(t.ctx.db, job.id, { state: 'failed', error: 'boom', finishedAt: '2026-01-01T00:00:00.000Z' });

  expect(await t.ctx.services.jobs.retry(job.id)).toMatchObject({ state: 'queued', trigger: 'retry', error: null });
  const history = await t.ctx.services.jobs.history({ jobId: job.id });
  expect(history.items[0]?.event).toBe('retried');
});

test('retry - resets the attempt counter so earlier failures do not count as interruptions', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  updateJobRow(t.ctx.db, job.id, { state: 'failed', attempts: 3 });

  await t.ctx.services.jobs.retry(job.id);

  expect(getJobRow(t.ctx.db, job.id)?.attempts).toBe(0);
});

test('pause - a user pause survives a restart until it is resumed', async () => {
  const s = setup();
  t = s.t;
  t.ctx.services.jobs.pause('user');

  expect(createJobsService(t.ctx).state().pauseReasons).toEqual(['user']);
  t.ctx.services.jobs.resume('user');
  expect(createJobsService(t.ctx).state().pauseReasons).toEqual([]);
});

test('retry - refuses when another job for the same file is active', async () => {
  const s = setup();
  t = s.t;
  const id = s.addFile();
  const old = await enqueueDisc(s, id);
  updateJobRow(t.ctx.db, old.id, { state: 'failed' });
  await enqueueDisc(s, id);
  await expectAppError(t.ctx.services.jobs.retry(old.id), 'conflict');
});

test('remove - deletes a finished job and its log, refuses active ones', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await expectAppError(t.ctx.services.jobs.remove(job.id), 'conflict');
  const logPath = join(t.ctx.config.get().jobLogDir, `${job.id}.txt`);
  writeFileSync(logPath, 'log');
  updateJobRow(t.ctx.db, job.id, { state: 'completed', logPath });
  const removed = waitForEvent(t.ctx.events, 'job.removed');

  await t.ctx.services.jobs.remove(job.id);

  expect(await removed).toEqual({ jobId: job.id });
  expect(existsSync(logPath)).toBe(false);
  await expectAppError(t.ctx.services.jobs.get(job.id), 'not_found');
});

test('log and remove - a stored log path outside the job log dir is never read or deleted', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  const outside = join(t.dir, 'secret.txt');
  writeFileSync(outside, 'secret');
  updateJobRow(t.ctx.db, job.id, { state: 'completed', logPath: outside });
  expect(existsSync(outside)).toBe(true);

  expect(await t.ctx.services.jobs.log(job.id)).toBeNull();
  expect((await t.ctx.services.jobs.get(job.id)).hasLog).toBe(false);
  await t.ctx.services.jobs.remove(job.id);

  expect(existsSync(outside)).toBe(true);
});

test('stop - a running job is aborted and re-queued without counting the attempt', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);

  await t.ctx.services.jobs.stop();

  expect(getJobRow(t.ctx.db, job.id)).toMatchObject({ state: 'queued', step: 'waiting', attempts: 0 });
  expect(t.ctx.services.jobs.state()).toMatchObject({ paused: true, pauseReasons: ['shutdown'], running: 0 });
  expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'needs_work']);
});

test('list - filters by state list, type and media file, newest first by default', async () => {
  const s = setup();
  t = s.t;
  const fileId = s.addFile();
  const a = await enqueueDisc(s, fileId);
  updateJobRow(t.ctx.db, a.id, { state: 'failed' });
  const b = await enqueueDisc(s, s.addFile());
  const c = await enqueueDisc(s, s.addFile());
  updateJobRow(t.ctx.db, c.id, { state: 'completed' });
  const jobs = t.ctx.services.jobs;

  expect((await jobs.list({})).items.map((job) => job.id)).toEqual([c.id, b.id, a.id]);
  expect((await jobs.list({ state: 'failed,completed', sortDir: 'asc' })).items.map((job) => job.id)).toEqual([
    a.id,
    c.id,
  ]);
  expect((await jobs.list({ mediaFileId: fileId })).items.map((job) => job.id)).toEqual([a.id]);
  expect((await jobs.list({ type: 'audio' })).total).toBe(0);
  expect(await jobs.list({ page: 2, pageSize: 2 })).toMatchObject({
    page: 2,
    pageSize: 2,
    total: 3,
    items: [{ id: a.id }],
  });
});

test('queue - running jobs first, then queued in pick order, with live progress', async () => {
  const s = setup();
  t = s.t;
  const progressed: JobExecutor = async (run) => {
    run.reportProgress({ progress: 0.5, speed: 7.7, etaSec: 12, outTimeSec: 30 });
    return s.gate.execute(run);
  };
  t.ctx.services.bdmv.execute = progressed;
  const first = await enqueueDisc(s, s.addFile());
  const second = await enqueueDisc(s, s.addFile(), 3);
  t.ctx.services.jobs.pause('user');
  const third = await enqueueDisc(s, s.addFile(), 5);
  t.ctx.services.jobs.resume('user');
  await t.ctx.services.jobs.start();
  await s.gate.waitStarted(1);

  const queue = await t.ctx.services.jobs.queue();

  expect(queue.items.map((job) => job.id)).toEqual([third.id, second.id, first.id]);
  expect(queue.items[0]).toMatchObject({ state: 'running', progress: 0.5, speed: 7.7, etaSec: 12 });
  expect(queue.state).toMatchObject({ running: 1, queued: 2 });
});

test('history - filters by event, job and media file', async () => {
  const s = setup();
  t = s.t;
  const jobs = t.ctx.services.jobs;
  await jobs.addHistory({ event: 'recycled', path: '/a', message: 'm1', mediaFileId: null });
  await jobs.addHistory({ event: 'imported', path: '/b', message: 'm2', data: { arrInstanceId: 3 } });

  const imported = await jobs.history({ event: 'imported' });
  expect(imported.total).toBe(1);
  expect(imported.items[0]).toMatchObject({ event: 'imported', path: '/b', data: { arrInstanceId: 3 }, jobId: null });
  expect((await jobs.history({ sortDir: 'asc' })).items.map((entry) => entry.message)).toEqual(['m1', 'm2']);
});

test('log - returns the per-job log text, null when there is none, 404 for unknown jobs', async () => {
  const s = setup();
  t = s.t;
  const job = await enqueueDisc(s, s.addFile());
  expect(await t.ctx.services.jobs.log(job.id)).toBeNull();
  await expectAppError(t.ctx.services.jobs.log(12345), 'not_found');
});

test('housekeeping - removes orphaned and expired job logs and stale temp files', async () => {
  const s = setup();
  t = s.t;
  const logDir = t.ctx.config.get().jobLogDir;
  const recent = await enqueueDisc(s, s.addFile());
  const old = await enqueueDisc(s, s.addFile());
  updateJobRow(t.ctx.db, old.id, { state: 'completed', finishedAt: '2020-01-01T00:00:00.000Z' });
  for (const id of [recent.id, old.id, 9999]) writeFileSync(join(logDir, `${id}.txt`), 'log');
  writeFileSync(join(logDir, 'notes.txt'), 'not a job log');
  const temp = join(t.dir, 'x.wololo-tmp.mkv');
  writeFileSync(temp, 'partial');
  insertJob(t.ctx.db, { sourcePath: join(t.dir, 'x.mkv'), state: 'failed', tempPath: temp });

  expect(await t.ctx.services.jobs.housekeeping()).toBe('deleted 1 temp file(s) and 2 job log(s)');

  expect(existsSync(join(logDir, `${recent.id}.txt`))).toBe(true);
  expect(existsSync(join(logDir, `${old.id}.txt`))).toBe(false);
  expect(existsSync(join(logDir, '9999.txt'))).toBe(false);
  expect(existsSync(join(logDir, 'notes.txt'))).toBe(true);
  expect(existsSync(temp)).toBe(false);
});

test('worker - a file ignored after its job was queued is never processed and stays ignored', async () => {
  const gate = gatedExecutor();
  t = createTestContext({
    settings: { processing: { enabled: true } },
    overrides: { bdmv: stubService<BdmvService>('bdmv', { execute: gate.execute }) },
  });
  const library = insertLibrary(t.ctx.db, { roots: [join(t.dir, 'movies')] });
  const row = insertMediaFile(t.ctx.db, library, { path: join(t.dir, 'movies', 'A'), kind: 'bdmv' });
  const job = await t.ctx.services.jobs.enqueue({
    type: 'bdmv',
    trigger: 'manual',
    mediaFileId: row.id,
    bdmvPlan: DISC_PLAN,
  });

  await t.ctx.services.media.setIgnored(row.id, true);
  await t.ctx.services.jobs.start();

  expect(getJobRow(t.ctx.db, job.id)?.state).toBe('cancelled');
  expect(gate.started).toEqual([]);
  expect(await t.ctx.services.media.get(row.id)).toMatchObject({ status: 'ignored', statusReason: 'ignored by user' });
});

test('worker - a claimed job is cancelled without touching the media status when its file is ignored or its library disabled', async () => {
  const s = setup();
  t = s.t;
  const ignored = await enqueueDisc(s, s.addFile());
  const ignoredId = ignored.mediaFileId as number;
  s.recorder.files.set(ignoredId, { ...(s.recorder.files.get(ignoredId) as MediaFileDetail), status: 'ignored' });
  const disabled = insertLibrary(t.ctx.db, { roots: [join(t.dir, 'off')], enabled: false });
  const offId = s.addFile();
  s.recorder.files.set(offId, { ...(s.recorder.files.get(offId) as MediaFileDetail), libraryId: disabled.libraryId });
  const off = await enqueueDisc(s, offId);
  const finished: number[] = [];
  const bothFinished = new Promise<void>((resolve) =>
    t?.ctx.events.on('job.finished', ({ job }) => {
      finished.push(job.id);
      if (finished.length === 2) resolve();
    }),
  );

  await t.ctx.services.jobs.start();
  await bothFinished;

  expect(s.gate.started).toEqual([]);
  expect(s.recorder.statuses).toEqual([]);
  expect(getJobRow(t.ctx.db, ignored.id)?.state).toBe('cancelled');
  expect(getJobRow(t.ctx.db, off.id)?.state).toBe('cancelled');
  const history = await t.ctx.services.jobs.history({ jobId: off.id, sortDir: 'asc' });
  expect(history.items.map((entry) => [entry.event, entry.message])).toEqual([
    ['queued', 'queued (manual)'],
    ['cancelled', 'cancelled: its library is disabled'],
  ]);
});
