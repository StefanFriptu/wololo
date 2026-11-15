import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { insertLibrary, insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { FileChangedEvent } from '../../contracts/integrations.ts';
import type { RecycleBinService } from '../../contracts/jobs.ts';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import type { AudioConversionInput, RulesService } from '../../contracts/rules-ffmpeg.ts';
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
  const proc = Bun.spawn([
    'ffmpeg',
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:V',
    '-c',
    'copy',
    '-f',
    'streamhash',
    '-hash',
    'md5',
    '-',
  ]);
  return (await new Response(proc.stdout).text()).trim();
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
  } = {},
): Promise<Setup> {
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
      rules:
        options.estimatedOutputBytes === undefined
          ? tools.rules
          : stubService<RulesService>('rules', {
              effectiveProfileForLibrary: tools.rules.effectiveProfileForLibrary,
              plan: (input) => ({
                ...ac3Plan(input.probe),
                estimatedOutputBytes: options.estimatedOutputBytes ?? null,
              }),
            }),
      media: service,
      ...(options.recycleBin ? { recycleBin: options.recycleBin } : {}),
    },
  });
  holder.root = join(context.dir, 'media', 'movies');
  const source = await ensureFixtureCopy(FIXTURES.dts51, join(holder.root, 'Movie (2020)'), 'Movie (2020).mkv');
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

  test('audio job - not enough free space fails before writing anything', async () => {
    const s = await setup({ estimatedOutputBytes: Number.MAX_SAFE_INTEGER });
    t = s.t;

    const { state, job } = await runOneJob(t, s.mediaFileId);

    expect(state).toBe('failed');
    expect(job.error).toContain('not enough free space');
    expect(readdirSync(dirname(s.source))).toEqual(['Movie (2020).mkv']);
  }, 60_000);

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
});
