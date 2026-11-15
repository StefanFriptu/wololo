import { expect, test } from 'bun:test';
import type { FfmpegProgress } from '../../contracts/rules-ffmpeg.ts';
import { createProgressParser } from './progress.ts';

function feed(durationSec: number, text: string): FfmpegProgress[] {
  const parser = createProgressParser(durationSec);
  return text.split('\n').flatMap((line) => parser.push(line) ?? []);
}

const BLOCK = `frame=240
fps=120.00
stream_0_0_q=-1.0
bitrate=1234.5kbits/s
total_size=1048576
out_time_us=30000000
out_time_ms=30000000
out_time=00:00:30.000000
dup_frames=0
drop_frames=0
speed=7.7x
progress=continue`;

test('createProgressParser - returns one update per key=value block', () => {
  expect(feed(120, BLOCK)).toEqual([
    {
      outTimeSec: 30,
      progress: 0.25,
      speed: 7.7,
      etaSec: 90 / 7.7,
      fps: 120,
      totalSizeBytes: 1048576,
      done: false,
    },
  ]);
});

test('createProgressParser - returns null for lines inside a block', () => {
  const parser = createProgressParser(10);
  expect(parser.push('frame=1')).toBeNull();
  expect(parser.push('out_time_us=1000000')).toBeNull();
  expect(parser.push('progress=continue')).not.toBeNull();
});

test('createProgressParser - progress=end is done with progress 1 and eta 0', () => {
  const [update] = feed(120, 'out_time_us=119500000\nspeed=8x\nprogress=end');
  expect(update).toMatchObject({ done: true, progress: 1, etaSec: 0, outTimeSec: 119.5 });
});

test.each([
  ['out_time_us', 'out_time_us=45000000', 45],
  ['out_time_ms (microseconds despite the name)', 'out_time_ms=45000000', 45],
  ['out_time clock', 'out_time=00:00:45.500000', 45.5],
  ['out_time over an hour', 'out_time=01:02:03.250000', 3723.25],
])('createProgressParser - reads %s', (_name, line, expected) => {
  const [update] = feed(4000, `${line}\nprogress=continue`);
  expect(update?.outTimeSec).toBe(expected);
});

test('createProgressParser - clamps progress to 1 when ffmpeg runs past the probed duration', () => {
  const [update] = feed(10, 'out_time_us=12000000\nspeed=2x\nprogress=continue');
  expect(update).toMatchObject({ progress: 1, etaSec: 0 });
});

test('createProgressParser - N/A values become null and keep the last known time', () => {
  const updates = feed(
    100,
    'out_time_us=10000000\nprogress=continue\nout_time_us=N/A\nout_time=N/A\nspeed=N/A\nfps=N/A\ntotal_size=N/A\nprogress=continue',
  );
  expect(updates[1]).toEqual({
    outTimeSec: 10,
    progress: 0.1,
    speed: null,
    etaSec: null,
    fps: null,
    totalSizeBytes: null,
    done: false,
  });
});

test('createProgressParser - negative start times count as zero', () => {
  const [update] = feed(100, 'out_time_us=-23000\nout_time=-00:00:00.023000\nprogress=continue');
  expect(update?.outTimeSec).toBe(0);
  expect(update?.progress).toBe(0);
});

test('createProgressParser - zero speed gives no eta', () => {
  const [update] = feed(100, 'out_time_us=0\nspeed=0x\nprogress=continue');
  expect(update).toMatchObject({ speed: null, etaSec: null });
});

test.each([0, -5, Number.NaN])(
  'createProgressParser - unknown duration %p keeps progress at 0 until the end',
  (duration) => {
    const updates = feed(duration, 'out_time_us=5000000\nspeed=3x\nprogress=continue\nprogress=end');
    expect(updates.map((update) => [update.progress, update.etaSec])).toEqual([
      [0, null],
      [1, 0],
    ]);
  },
);

test('createProgressParser - ignores blank, malformed and carriage-return lines', () => {
  const updates = feed(100, '\r\nnot a key value\n=5\nout_time_us=50000000\r\nprogress=continue\r');
  expect(updates).toHaveLength(1);
  expect(updates[0]?.outTimeSec).toBe(50);
});
