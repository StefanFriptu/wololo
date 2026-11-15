import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixture, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import type { VerifyRequest } from '../../contracts/jobs.ts';
import { runProcess } from '../../core/process.ts';
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
});
