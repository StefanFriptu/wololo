import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixture, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { AppError } from '../../core/errors.ts';
import type { AudioStream } from '../../shared/domain.ts';

let t: TestContext;

beforeAll(() => {
  t = createTestContext();
});

afterAll(() => t.cleanup());

test('probe - missing file is not_found', async () => {
  const error = await t.ctx.services.probe.probe(join(t.dir, 'missing.mkv')).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('not_found');
});

test('probe - missing ffprobe binary is an upstream error', async () => {
  const broken = createTestContext({ env: { WOLOLO__FFPROBE: join(t.dir, 'no-such-ffprobe') } });
  try {
    const file = join(broken.dir, 'a.mkv');
    writeFileSync(file, 'x');
    const error = await broken.ctx.services.probe.probe(file).catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('upstream');
  } finally {
    broken.cleanup();
  }
});

function countingFfprobe(dir: string): { env: Record<string, string>; counts: () => number[] } {
  const script = join(dir, 'fake-ffprobe.sh');
  const log = join(dir, 'probe-counts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `mkdir -p '${dir}/running' && touch '${dir}/running/'$$`,
      `ls '${dir}/running' | wc -l >> '${log}'`,
      'sleep 0.2',
      `rm '${dir}/running/'$$`,
      "echo '{}'",
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return {
    env: { WOLOLO__FFPROBE: script },
    counts: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\s+/).map(Number) : []),
  };
}

test('probe - runs at most 2 ffprobe processes at once', async () => {
  const fake = countingFfprobe(t.dir);
  const limited = createTestContext({ env: fake.env });
  try {
    const file = join(limited.dir, 'a.mkv');
    writeFileSync(file, 'x');

    const results = await Promise.all(Array.from({ length: 6 }, () => limited.ctx.services.probe.probe(file)));

    expect(results).toHaveLength(6);
    expect(fake.counts()).toHaveLength(6);
    expect(Math.max(...fake.counts())).toBeLessThanOrEqual(2);
  } finally {
    limited.cleanup();
  }
});

test('probe - aborted while queued never spawns ffprobe', async () => {
  const fake = countingFfprobe(join(t.dir, 'abort'));
  const limited = createTestContext({ env: fake.env });
  try {
    const file = join(limited.dir, 'a.mkv');
    writeFileSync(file, 'x');
    const busy = [limited.ctx.services.probe.probe(file), limited.ctx.services.probe.probe(file)];
    const controller = new AbortController();
    const queued = limited.ctx.services.probe.probe(file, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));

    controller.abort();

    const error = await queued.catch((caught: unknown) => caught);
    expect((error as AppError).message).toContain('ffprobe aborted');
    await Promise.all(busy);
    expect(await limited.ctx.services.probe.probe(file)).toMatchObject({ path: file });
    expect(fake.counts()).toHaveLength(3);
  } finally {
    limited.cleanup();
  }
});

describe.skipIf(!ffmpegAvailable())('probe with ffprobe', () => {
  test('probe - DTS 5.1 fixture with subtitle and chapters', async () => {
    const path = await ensureFixture(FIXTURES.dts51);
    const result = await t.ctx.services.probe.probe(path);
    expect(result.path).toBe(path);
    expect(result.formatName).toContain('matroska');
    expect(result.durationSec).toBeGreaterThan(2.5);
    expect(result.sizeBytes).toBe(Bun.file(path).size);
    expect(result.chapterCount).toBe(3);
    expect(result.streams.map((stream) => [stream.kind, stream.codec])).toEqual([
      ['video', 'h264'],
      ['audio', 'dts'],
      ['subtitle', 'subrip'],
    ]);
    const audio = result.streams[1] as AudioStream;
    expect(audio).toMatchObject({ channels: 6, sampleRate: 48000, language: 'eng', title: 'DTS 5.1', default: true });
  });

  test('probe - TrueHD plus AC3 keeps stream order and flags', async () => {
    const result = await t.ctx.services.probe.probe(await ensureFixture(FIXTURES.truehd51PlusAc3));
    const audio = result.streams.filter((stream) => stream.kind === 'audio') as AudioStream[];
    expect(audio.map((stream) => [stream.codec, stream.lossless, stream.default])).toEqual([
      ['truehd', true, true],
      ['ac3', false, false],
    ]);
  });

  test('probe - mp4 container and languages normalised', async () => {
    const result = await t.ctx.services.probe.probe(await ensureFixture(FIXTURES.aacStereo));
    expect(result.formatName).toContain('mp4');
    expect(result.streams.find((stream) => stream.kind === 'audio')?.language).toBe('eng');
  });

  test('probe - without chapters', async () => {
    const result = await t.ctx.services.probe.probe(await ensureFixture(FIXTURES.dts51), { withChapters: false });
    expect(result.chapterCount).toBe(0);
  });

  test('probe - a file that is not media is an upstream error', async () => {
    const path = join(t.dir, 'not-media.mkv');
    writeFileSync(path, 'this is not a matroska file');
    const error = await t.ctx.services.probe.probe(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('upstream');
    expect((error as AppError).message).toContain('ffprobe failed');
  });

  test('probe - an aborted signal stops ffprobe', async () => {
    const controller = new AbortController();
    controller.abort();
    const path = await ensureFixture(FIXTURES.dts51);
    const error = await t.ctx.services.probe
      .probe(path, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('upstream');
  });
});
