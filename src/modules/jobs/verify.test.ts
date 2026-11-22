import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixture, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import type { VerifyRequest } from '../../contracts/jobs.ts';
import { runProcess } from '../../core/process.ts';
import { buildAudioConversionArgs } from '../ffmpeg/args.ts';
import { buildProbeArgs } from '../probe/args.ts';
import { parseFfprobeOutput } from '../probe/parse.ts';
import { samsungTizenDefinition } from '../profiles/defaults.ts';
import { planConversion, resolveEffectiveProfile } from '../rules/engine.ts';
import { createVerifier } from './verify.ts';

const verify = createVerifier({
  run: (options) => runProcess({ ...options, lowPriority: false }),
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
});

async function ffmpeg(args: string[]) {
  const result = await runProcess({
    command: 'ffmpeg',
    args: ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args],
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

describe.skipIf(!ffmpegAvailable())('createVerifier on real files', () => {
  let dir = '';
  let source = '';
  let good = '';
  const request = (overrides: Partial<VerifyRequest> = {}): VerifyRequest => ({
    sourcePath: source,
    outputPath: good,
    expectedDurationSec: 3,
    expectedStreamCount: 3,
    compareVideoHash: true,
    decodeAudioStreams: [1],
    expectedChapterCount: 3,
    expectedLanguages: [
      { kind: 'video', language: null },
      { kind: 'audio', language: 'eng' },
      { kind: 'subtitle', language: 'eng' },
    ],
    ...overrides,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wololo-verify-'));
    source = await ensureFixture(FIXTURES.dts51);
    good = join(dir, 'good.wololo-tmp.mkv');
    await ffmpeg(['-i', source, '-map', '0', '-c', 'copy', '-c:a', 'ac3', '-b:a', '640k', '-f', 'matroska', good]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('verify - a correct conversion passes every check', async () => {
    const result = await verify(request({ expectedVideoPackets: 72 }));
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(result.checks.map((check) => check.name)).toEqual([
      'output_exists',
      'duration',
      'stream_count',
      'video_checksum',
      'video_packets',
      'audio_decode',
      'chapters',
      'languages',
    ]);
    expect(result.passed).toBe(true);
  });

  test('verify - optional checks are skipped when not requested', async () => {
    const result = await verify(
      request({
        compareVideoHash: false,
        decodeAudioStreams: [],
        expectedChapterCount: undefined,
        expectedLanguages: undefined,
      }),
    );
    expect(result.checks.map((check) => check.name)).toEqual(['output_exists', 'duration', 'stream_count']);
  });

  test('verify - streamhash output that yields no hashes fails instead of passing as "no video"', async () => {
    const blind = createVerifier({
      run: async (options) => {
        const result = await runProcess({ ...options, lowPriority: false });
        return options.args.includes('streamhash') ? { ...result, stdout: 'unexpected format\n' } : result;
      },
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    });
    const result = await blind(request());
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'video_checksum')).toEqual({
      name: 'video_checksum',
      passed: false,
      detail: '0 video hashes for 1 video streams in the output',
    });
  });

  test('verify - a missing output fails only output_exists', async () => {
    const result = await verify(request({ outputPath: join(dir, 'missing.mkv') }));
    expect(result).toEqual({
      passed: false,
      checks: [{ name: 'output_exists', passed: false, detail: `${join(dir, 'missing.mkv')} is missing` }],
    });
  });

  test('verify - re-encoded video fails the checksum', async () => {
    const reencoded = join(dir, 'reencoded.mkv');
    await ffmpeg([
      '-i',
      source,
      '-map',
      '0',
      '-c',
      'copy',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '40',
      reencoded,
    ]);
    const result = await verify(request({ outputPath: reencoded }));
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'video_checksum')?.passed).toBe(false);
  });

  test('verify - wrong stream count, chapters and languages are reported', async () => {
    const result = await verify(
      request({
        expectedStreamCount: 4,
        expectedChapterCount: 0,
        expectedLanguages: [
          { kind: 'video', language: null },
          { kind: 'audio', language: 'ger' },
          { kind: 'subtitle', language: 'eng' },
        ],
      }),
    );
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      'stream_count',
      'chapters',
      'languages',
    ]);
  });

  test('verify - a truncated output fails duration and the full audio decode', async () => {
    const broken = join(dir, 'broken.mkv');
    await ffmpeg(['-i', source, '-map', '0', '-c', 'copy', '-c:a', 'ac3', '-b:a', '640k', broken]);
    truncateSync(broken, Math.floor(statSync(broken).size * 0.6));
    const result = await verify(request({ outputPath: broken }));
    expect(result.passed).toBe(false);
    const failed = result.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('audio_decode');
  });

  test('verify - decoding a stream index that does not exist fails audio_decode', async () => {
    const result = await verify(request({ decodeAudioStreams: [7] }));
    expect(result.checks.find((check) => check.name === 'audio_decode')?.passed).toBe(false);
  });

  test('verify - an mp4 with cover art converted through the plan passes every check and keeps no picture', async () => {
    const mp4 = join(dir, 'cover.mp4');
    const cover = join(dir, 'cover.jpg');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover]);
    await ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24:duration=2'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', cover],
      ...['-map', '0', '-map', '1', '-map', '2', '-c:v:0', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      ...['-c:v:1', 'copy', '-disposition:v:1', 'attached_pic', '-c:a', 'aac', mp4],
    ]);
    const probeRun = await runProcess({ command: 'ffprobe', args: buildProbeArgs(mp4) });
    const probe = parseFfprobeOutput(JSON.parse(probeRun.stdout), mp4, statSync(mp4).size, new Date().toISOString());
    const base = samsungTizenDefinition();
    const definition = { ...base, audio: { ...base.audio, allowedCodecs: ['ac3'], targetCodec: 'ac3' as const } };
    const plan = planConversion({
      probe,
      profile: resolveEffectiveProfile([
        {
          id: 1,
          name: 'ac3 only',
          description: '',
          version: 1,
          builtin: false,
          definition,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      library: {
        mode: 'replace',
        keepLanguages: [],
        keepOriginalLanguage: true,
        keepUndetermined: true,
        fillMissingLanguage: 'off',
      },
      originalLanguage: null,
    });
    expect(plan.action).toBe('convert');
    const output = join(dir, 'cover.wololo-tmp.mkv');
    const args = buildAudioConversionArgs({ inputPath: mp4, outputPath: output, probe, plan });
    expect((await runProcess({ command: 'ffmpeg', args })).exitCode).toBe(0);

    const result = await verify({
      sourcePath: mp4,
      outputPath: output,
      expectedDurationSec: probe.durationSec,
      expectedStreamCount: plan.streams.length,
      compareVideoHash: true,
      decodeAudioStreams: [1],
      expectedChapterCount: probe.chapterCount,
      expectedLanguages: plan.streams.map((stream) => ({ kind: stream.kind, language: stream.language })),
    });

    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    const after = await runProcess({
      command: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', output],
    });
    expect(after.stdout.trim().split('\n')).toEqual(['h264', 'ac3']);
  }, 60_000);

  test.each([
    ['h264', 'libx264'],
    ['hevc', 'libx265'],
  ])(
    'verify - an MPEG-TS %s source remuxed to Matroska passes the video check',
    async (codec, encoder) => {
      const ts = join(dir, `${codec}.ts`);
      await ffmpeg([
        ...['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2'],
        ...['-c:v', encoder, '-preset', 'ultrafast', '-bf', '2', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'eac3'],
        ...['-f', 'mpegts', ts],
      ]);
      const mkv = join(dir, `${codec}.wololo-tmp.mkv`);
      await ffmpeg(['-i', ts, '-map', '0', '-c', 'copy', '-c:a', 'ac3', '-f', 'matroska', mkv]);
      const dropped = join(dir, `${codec}-dropped.mkv`);
      await ffmpeg(['-i', ts, '-map', '0', '-c', 'copy', '-c:a', 'ac3', '-frames:v', '40', '-f', 'matroska', dropped]);
      const tsRequest = (outputPath: string): VerifyRequest => ({
        sourcePath: ts,
        outputPath,
        expectedDurationSec: 2,
        durationToleranceSec: 0.5,
        expectedStreamCount: 2,
        compareVideoHash: true,
        decodeAudioStreams: [1],
      });

      const good = await verify(tsRequest(mkv));
      const bad = await verify(tsRequest(dropped));

      expect(good.checks.filter((check) => !check.passed)).toEqual([]);
      expect(good.checks.find((check) => check.name === 'video_checksum')?.detail).toContain('MPEG-TS source');
      expect(bad.checks.find((check) => check.name === 'video_checksum')?.passed).toBe(false);
    },
    60_000,
  );
});
