import { describe, expect, test } from 'bun:test';
import { buildFixtureArgs, ensureFixture, FIXTURES, ffmpegAvailable, fixtureFileName } from './fixtures.ts';

describe('buildFixtureArgs', () => {
  test('maps every track, tags languages and enables experimental encoders', () => {
    const args = buildFixtureArgs(FIXTURES.multiLanguage, '/tmp/out.mkv', {
      subtitles: ['/tmp/a.srt', '/tmp/b.srt', '/tmp/c.srt'],
      chapters: '/tmp/ch.txt',
    });
    expect(args.filter((a) => a === '-map')).toHaveLength(7);
    expect(args).toContain('dca');
    expect(args.join(' ')).toContain('-metadata:s:a:0 language=spa');
    expect(args.join(' ')).toContain('-disposition:s:1 forced');
    expect(args.join(' ')).toContain('-strict -2');
    expect(args.at(-1)).toBe('/tmp/out.mkv');
  });

  test('cache file names change with the spec', () => {
    expect(fixtureFileName(FIXTURES.dts51)).not.toBe(fixtureFileName({ ...FIXTURES.dts51, durationSec: 4 }));
  });
});

describe.skipIf(!ffmpegAvailable())('ensureFixture', () => {
  test('generates a probe-able file with the requested streams', async () => {
    const path = await ensureFixture(FIXTURES.truehd51PlusAc3);
    const proc = Bun.spawn(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', path], {
      stdout: 'pipe',
    });
    const probe = (await new Response(proc.stdout).json()) as {
      streams: { codec_name: string; channels?: number }[];
    };
    expect(probe.streams.map((s) => s.codec_name)).toEqual(['h264', 'truehd', 'ac3']);
    expect(probe.streams[1]?.channels).toBe(6);
  });
});
