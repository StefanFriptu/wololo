import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, type FixtureSpec, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { FileChangedEvent } from '../../contracts/integrations.ts';
import type { RecycleBinService } from '../../contracts/jobs.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import type { AudioConversionInput, RulesService } from '../../contracts/rules-ffmpeg.ts';
import type { ConversionPlan, ProbeResult } from '../../shared/domain.ts';
import { getJobRow } from './jobQueries.ts';
import { tempPathFor } from './paths.ts';
import {
  ac3ConversionArgs,
  ac3Plan,
  type MediaRecorder,
  mediaDetail,
  realMediaToolServices,
  recordingMediaService,
  sha256,
  waitForEvent,
} from './test-support.ts';

interface ProbedStream {
  codec_type: string;
  codec_name: string;
  channels?: number;
  bit_rate?: string;
}

async function ffprobeJson(
  path: string,
): Promise<{ streams: ProbedStream[]; format: { duration: string }; chapters: unknown[] }> {
  const proc = Bun.spawn([
    'ffprobe',
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(await new Response(proc.stdout).text());
}

async function videoHash(path: string): Promise<string> {
  const proc = Bun.spawn(
    ['ffmpeg', '-v', 'error', '-i', path, '-map', '0:V', '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  const hash = text.trim();
  expect(hash).toMatch(/^0,v,MD5=[0-9a-f]{32}$/);
  return hash;
}

let t: TestContext | null = null;
afterEach(async () => {
  await t?.ctx.services.jobs.stop();
  t?.cleanup();
  t = null;
});

interface Setup {
  t: TestContext;
  source: string;
  mediaFileId: number;
  recorder: MediaRecorder;
  notified: FileChangedEvent[];
}

async function setup(
  options: {
    args?: (input: AudioConversionInput) => string[];
    recycleBin?: RecycleBinService;
    estimatedOutputBytes?: number;
    fixture?: FixtureSpec;
    fileName?: string;
    plan?: (probe: ProbeResult) => ConversionPlan;
  } = {},
): Promise<Setup> {
  const planFor = (probe: ProbeResult): ConversionPlan => {
    const plan = options.plan ? options.plan(probe) : ac3Plan(probe);
    return options.estimatedOutputBytes === undefined
      ? plan
      : { ...plan, estimatedOutputBytes: options.estimatedOutputBytes };
  };
  const notified: FileChangedEvent[] = [];
  const holder: { root: string } = { root: '' };
  const { service, recorder } = recordingMediaService([]);
  const tools = realMediaToolServices({ notified, args: options.args });
  const context = createTestContext({
    settings: { processing: { enabled: true } },
    overrides: {
      ...tools,
      libraries: stubService<LibraryService>('libraries', {
        get: tools.libraries.get,
        findRootForPath: async () => ({ library: await tools.libraries.get(1), rootId: 1, rootPath: holder.root }),
      }),
      rules: stubService<RulesService>('rules', {
        effectiveProfileForLibrary: tools.rules.effectiveProfileForLibrary,
        plan: (input) => planFor(input.probe),
      }),
      media: service,
      ...(options.recycleBin ? { recycleBin: options.recycleBin } : {}),
    },
  });
  holder.root = join(context.dir, 'media', 'movies');
  const source = await ensureFixtureCopy(
    options.fixture ?? FIXTURES.dts51,
    join(holder.root, 'Movie (2020)'),
    options.fileName ?? 'Movie (2020).mkv',
  );
  const library = insertLibrary(context.ctx.db, { roots: [holder.root] });
  const row = insertMediaFile(context.ctx.db, library, { path: source });
  recorder.files.set(row.id, mediaDetail(row.id, source, { libraryId: library.libraryId }));
  return { t: context, source, mediaFileId: row.id, recorder, notified };
}

async function runOneJob(context: TestContext, mediaFileId: number) {
  const finished = waitForEvent(context.ctx.events, 'job.finished');
  await context.ctx.services.jobs.enqueue({ type: 'audio', trigger: 'manual', mediaFileId });
  await context.ctx.services.jobs.start();
  return finished;
}

describe.skipIf(!ffmpegAvailable())('audio job end to end', () => {
  test('audio job - 5.1 DTS becomes one AC3 5.1 640 kbps track with bit-identical video and the same duration', async () => {
    const s = await setup();
    t = s.t;
    chmodSync(s.source, 0o640);
    const originalHash = await sha256(s.source);
    const originalVideo = await videoHash(s.source);
    const originalProbe = await ffprobeJson(s.source);
    expect(
      originalProbe.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.codec_name),
    ).toEqual(['dts']);
    const steps: string[] = [];
    const progress: { progress: number; speed: number | null }[] = [];
    t.ctx.events.on('job.step', (event) => steps.push(event.step));
    t.ctx.events.on('job.progress', (event) => progress.push(event));

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    const output = await ffprobeJson(s.source);
    const audio = output.streams.filter((stream) => stream.codec_type === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ codec_name: 'ac3', channels: 6, bit_rate: '640000' });
    expect(output.streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio', 'subtitle']);
    expect(await videoHash(s.source)).toBe(originalVideo);
    expect(Math.abs(Number(output.format.duration) - Number(originalProbe.format.duration))).toBeLessThanOrEqual(0.1);
    expect(output.chapters).toHaveLength(3);
    expect(statSync(s.source).mode & 0o777).toBe(0o640);
    expect(existsSync(tempPathFor(s.source))).toBe(false);

    const detail = await t.ctx.services.jobs.get(job.id);
    expect(detail.verification?.passed).toBe(true);
    expect(detail.verification?.checks.map((check) => check.name)).toEqual([
      'output_exists',
      'duration',
      'stream_count',
      'video_checksum',
      'audio_decode',
      'chapters',
      'languages',
    ]);
    expect(detail.after?.filter((stream) => stream.kind === 'audio').map((stream) => stream.codec)).toEqual(['ac3']);
    expect(detail.outputPath).toBe(s.source);
    expect(detail.hasLog).toBe(true);

    const bin = await t.ctx.services.recycleBin.list({});
    expect(bin.total).toBe(1);
    expect(bin.items[0]?.originalPath).toBe(s.source);
    expect(bin.items[0]?.recyclePath).toContain(join('media', 'movies', '.wololo-recycle'));
    expect(await sha256(bin.items[0]?.recyclePath ?? '')).toBe(originalHash);
    expect(detail.recycleBinEntryId).toBe(bin.items[0]?.id ?? -1);

    expect(steps).toEqual(['preparing', 'encoding', 'verifying', 'replacing', 'notifying']);
    expect(progress.at(-1)?.progress).toBe(1);
    expect(progress.some((event) => (event.speed ?? 0) > 0)).toBe(true);
    expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing']);
    expect(s.recorder.results).toHaveLength(1);
    expect(s.recorder.results[0]?.update).toMatchObject({ status: 'compatible', lastJobId: job.id });
    expect(s.notified).toEqual([
      {
        kind: 'replaced',
        localPath: s.source,
        mediaFileId: s.mediaFileId,
        arr: { instanceId: 1, kind: 'radarr', itemId: 7, fileId: null },
        jobId: job.id,
      },
    ]);

    const log = (await t.ctx.services.jobs.log(job.id)) ?? '';
    expect(log).toContain('$ ffmpeg');
    expect(log).toContain('verify video_checksum: ok');
    expect(log).toContain('free space in');
    const history = await t.ctx.services.jobs.history({ jobId: job.id, sortDir: 'asc' });
    expect(history.items.map((entry) => entry.event)).toEqual(['queued', 'started', 'recycled', 'completed']);
    expect(history.items.at(-1)).toMatchObject({
      message: 'converted: dts -> ac3 5.1 640 kbps',
      data: { outputPath: s.source, recycleBinEntryId: bin.items[0]?.id },
    });
  }, 60_000);

  test.each<[string, (input: AudioConversionInput) => string[], string]>([
    [
      'video stream dropped',
      (input) =>
        ac3ConversionArgs({
          ...input,
          plan: { ...input.plan, streams: input.plan.streams.filter((s) => s.kind !== 'video') },
        }),
      'video_checksum',
    ],
    [
      'output cut short',
      (input) => [...ac3ConversionArgs(input).slice(0, -1), '-t', '1', input.outputPath],
      'duration',
    ],
  ])(
    'audio job - verification failure (%s) leaves the original untouched',
    async (_name, args, failedCheck) => {
      const s = await setup({ args });
      t = s.t;
      const originalHash = await sha256(s.source);

      const { state, job } = await runOneJob(t, s.mediaFileId);

      expect(state).toBe('failed');
      expect(job.error).toContain('verification failed');
      expect(job.error).toContain(failedCheck);
      expect(await sha256(s.source)).toBe(originalHash);
      expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
      expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
      const detail = await t.ctx.services.jobs.get(job.id);
      expect(detail.verification?.passed).toBe(false);
      expect(getJobRow(t.ctx.db, job.id)?.tempPath).toBeNull();
      expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'failed']);
      expect(s.recorder.results).toHaveLength(0);
      expect(s.notified).toHaveLength(0);
    },
    60_000,
  );

  test('audio job - ffmpeg failure leaves the original untouched and no temp file', async () => {
    const s = await setup({
      args: (input) => ['-v', 'error', '-i', input.inputPath, '-map', '0:99', input.outputPath],
    });
    t = s.t;
    const originalHash = await sha256(s.source);

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('failed');
    expect(job.error).toMatch(/^ffmpeg exited with \d+/);
    expect(await sha256(s.source)).toBe(originalHash);
    expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
  }, 60_000);

  test('audio job - not enough free space re-queues the job before writing anything', async () => {
    const s = await setup({ estimatedOutputBytes: Number.MAX_SAFE_INTEGER });
    t = s.t;
    const job = await t.ctx.services.jobs.enqueue({ type: 'audio', trigger: 'manual', mediaFileId: s.mediaFileId });
    const requeued = waitForEvent(t.ctx.events, 'job.queued');

    await t.ctx.services.jobs.start();

    expect((await requeued).job).toMatchObject({ id: job.id, state: 'queued' });
    expect(getJobRow(t.ctx.db, job.id)).toMatchObject({ state: 'queued', attempts: 0, tempPath: null, error: null });
    expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
    expect(s.recorder.statuses.map((entry) => entry.status)).toEqual(['processing', 'needs_work']);
    const history = await t.ctx.services.jobs.history({ jobId: job.id });
    expect(history.items[0]?.message).toContain('waiting for free space: not enough free space');
    expect((await t.ctx.services.jobs.log(job.id)) ?? '').toContain('waiting for free space');
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)(
    'audio job - a recycle bin that cannot be written fails the job before encoding',
    async () => {
      const s = await setup();
      t = s.t;
      const locked = join(t.dir, 'locked');
      mkdirSync(locked);
      t.ctx.settings.update({ recycleBin: { path: join(locked, 'bin') } });
      chmodSync(locked, 0o500);
      const steps: string[] = [];
      t.ctx.events.on('job.step', (event) => steps.push(event.step));
      try {
        const { state, job } = await runOneJob(t, s.mediaFileId);

        expect(state).toBe('failed');
        expect(job.error).toContain('is not writable');
        expect(steps).toEqual(['preparing']);
        expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
        expect((await t.ctx.services.jobs.log(job.id)) ?? '').not.toContain('$ ffmpeg');
      } finally {
        chmodSync(locked, 0o700);
      }
    },
    60_000,
  );

  test('audio job - a failure inside the replace step keeps the original and drops the temp file', async () => {
    const s = await setup({
      recycleBin: stubService<RecycleBinService>('recycleBin', {
        recycleForReplace: async () => {
          throw new Error('bin unavailable');
        },
      }),
    });
    t = s.t;
    const originalHash = await sha256(s.source);

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('failed');
    expect(job.error).toBe('bin unavailable');
    expect(job.step).toBe('replacing');
    expect(await sha256(s.source)).toBe(originalHash);
    expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
  }, 60_000);

  test('audio job - recycle bin disabled replaces without keeping the original', async () => {
    const s = await setup();
    t = s.t;
    t.ctx.settings.update({ recycleBin: { enabled: false } });

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    expect(job.outputPath).toBe(s.source);
    expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
    expect(existsSync(join(dirname(dirname(s.source)), '.wololo-recycle'))).toBe(false);
  }, 60_000);

  test('audio job - TrueHD + AC3 is remuxed to the AC3 track alone without encoding', async () => {
    const s = await setup({
      fixture: FIXTURES.truehd51PlusAc3,
      plan: (probe) => {
        const plan = ac3Plan(probe);
        const truehd = probe.streams.find((stream) => stream.codec === 'truehd');
        return {
          ...plan,
          action: 'remux',
          reasons: ['truehd dropped, ac3 kept'],
          streams: plan.streams.filter((stream) => stream.sourceIndex !== truehd?.index),
          dropped: truehd
            ? [
                {
                  sourceIndex: truehd.index,
                  kind: 'audio',
                  codec: 'truehd',
                  language: truehd.language,
                  reason: 'compatible_duplicate',
                },
              ]
            : [],
        };
      },
    });
    t = s.t;
    const originalVideo = await videoHash(s.source);
    const originalProbe = await ffprobeJson(s.source);
    const steps: string[] = [];
    t.ctx.events.on('job.step', (event) => steps.push(event.step));

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    const output = await ffprobeJson(s.source);
    expect(output.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'ac3'],
    ]);
    expect(await videoHash(s.source)).toBe(originalVideo);
    expect(Math.abs(Number(output.format.duration) - Number(originalProbe.format.duration))).toBeLessThanOrEqual(0.1);
    expect(steps).toEqual(['preparing', 'muxing', 'verifying', 'replacing', 'notifying']);
    const detail = await t.ctx.services.jobs.get(job.id);
    expect(detail.verification?.checks.map((check) => check.name)).not.toContain('audio_decode');
    expect(detail.verification?.checks.find((check) => check.name === 'stream_count')?.detail).toBe(
      '2 streams, expected 2',
    );
    const history = await t.ctx.services.jobs.history({ jobId: job.id, event: 'completed' });
    expect(history.items[0]?.message).toBe('converted: remuxed (1 streams dropped)');
  }, 60_000);

  test('audio job - an mp4 source becomes an mkv next to it, the mp4 goes to the bin and the media row moves', async () => {
    const s = await setup({
      fixture: FIXTURES.aacStereo,
      fileName: 'Movie (2020).mp4',
      plan: (probe) => ac3Plan(probe, ['ac3']),
    });
    t = s.t;
    const originalHash = await sha256(s.source);
    const originalVideo = await videoHash(s.source);
    const output = join(dirname(s.source), 'Movie (2020).mkv');

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    expect(job.outputPath).toBe(output);
    expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
    const probe = await ffprobeJson(output);
    expect(probe.streams.filter((stream) => stream.codec_type === 'audio')).toMatchObject([
      { codec_name: 'ac3', channels: 2, bit_rate: '448000' },
    ]);
    expect(await videoHash(output)).toBe(originalVideo);
    const bin = await t.ctx.services.recycleBin.list({});
    expect(bin.items.map((entry) => entry.originalPath)).toEqual([s.source]);
    expect(await sha256(bin.items[0]?.recyclePath ?? '')).toBe(originalHash);
    expect(s.recorder.results[0]?.update).toMatchObject({ status: 'compatible', lastJobId: job.id, path: output });
    expect(s.recorder.files.get(s.mediaFileId)?.path).toBe(output);
    expect(s.notified.map((event) => event.localPath)).toEqual([output]);
  }, 60_000);

  test('audio job - an mkv that appears at the output path during the encode is never overwritten', async () => {
    const output = { path: '' };
    const s = await setup({
      fixture: FIXTURES.aacStereo,
      fileName: 'Movie (2020).mp4',
      plan: (probe) => ac3Plan(probe, ['ac3']),
      args: (input) => {
        writeFileSync(output.path, 'dropped in by someone else');
        return ac3ConversionArgs(input);
      },
    });
    t = s.t;
    output.path = join(dirname(s.source), 'Movie (2020).mkv');
    const originalHash = await sha256(s.source);

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('failed');
    expect(job.error).toContain('output path appeared during the job');
    expect(await sha256(s.source)).toBe(originalHash);
    expect(readFileSync(output.path, 'utf8')).toBe('dropped in by someone else');
    expect(readdirSync(dirname(s.source)).sort()).toEqual(['Movie (2020).mkv', 'Movie (2020).mp4']);
    expect((await t.ctx.services.recycleBin.list({})).total).toBe(0);
    expect(s.notified).toEqual([]);
  }, 60_000);

  test('audio job - lost features and retagged streams of the executed plan land in the completed history entry', async () => {
    const s = await setup({
      plan: (probe) => {
        const plan = ac3Plan(probe);
        return {
          ...plan,
          lostFeatures: ['DTS-HD MA lossless audio replaced by AC3'],
          streams: plan.streams.map((stream) =>
            stream.kind === 'subtitle' ? { ...stream, language: 'eng', retagged: true } : stream,
          ),
        };
      },
    });
    t = s.t;

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    const detail = await t.ctx.services.jobs.get(job.id);
    expect(detail.lostFeatures).toEqual(['DTS-HD MA lossless audio replaced by AC3']);
    const history = await t.ctx.services.jobs.history({ jobId: job.id, event: 'completed' });
    expect(history.items[0]?.data).toMatchObject({
      lostFeatures: ['DTS-HD MA lossless audio replaced by AC3'],
      retagged: ['subtitle 2 -> eng'],
    });
  }, 60_000);

  test('audio job - a compatible file completes as skipped without writing', async () => {
    const s = await setup();
    t = s.t;
    const ac3 = await ensureFixtureCopy(FIXTURES.ac3Compatible, dirname(s.source), 'Other.mkv');
    s.recorder.files.set(s.mediaFileId, mediaDetail(s.mediaFileId, ac3));
    const before = await sha256(ac3);

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    expect(job.outputPath).toBeNull();
    expect(await sha256(ac3)).toBe(before);
    const history = await t.ctx.services.jobs.history({ jobId: job.id });
    expect(history.items[0]?.event).toBe('skipped');
  }, 60_000);

  test('audio job - a plan that turned blocked since queueing skips the file and marks it blocked, not failed', async () => {
    const s = await setup({
      plan: (probe) => ({ ...ac3Plan(probe), action: 'blocked', reasons: ['video h264 not decoded by profile'] }),
    });
    t = s.t;
    const before = await sha256(s.source);

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('completed');
    expect(await sha256(s.source)).toBe(before);
    expect(s.recorder.results[0]?.update).toMatchObject({
      status: 'blocked',
      reason: 'blocked: video h264 not decoded by profile',
    });
    const history = await t.ctx.services.jobs.history({ jobId: job.id });
    expect(history.items[0]).toMatchObject({
      event: 'skipped',
      message: 'blocked: video h264 not decoded by profile; nothing written',
    });
  }, 60_000);
});
