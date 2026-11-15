import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { insertJob } from '../../../test/helpers/seed.ts';
import { AppError } from '../../core/errors.ts';
import type { EventMap } from '../../shared/events.ts';
import { getJobRow } from './jobQueries.ts';
import type { LiveProgress } from './mappers.ts';
import { createRunContext } from './runContext.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup() {
  t = createTestContext();
  const row = insertJob(t.ctx.db, { sourcePath: '/data/m/a.mkv', state: 'running', step: 'encoding' });
  const clock = { now: 0 };
  const lines: string[] = [];
  const live: LiveProgress[] = [];
  const controller = new AbortController();
  const run = createRunContext({
    ctx: t.ctx,
    row,
    signal: controller.signal,
    jobLog: { line: (text) => lines.push(text), section: (title) => lines.push(`== ${title}`) },
    setLive: (progress) => live.push(progress),
    now: () => clock.now,
  });
  return { t, row, run, clock, lines, live, controller };
}

test('reportProgress - emits at most one event per 500 ms, always the final one, and persists every 5 s', () => {
  const s = setup();
  const events: EventMap['job.progress'][] = [];
  s.t.ctx.events.on('job.progress', (event) => events.push(event));
  const at = (ms: number, progress: number) => {
    s.clock.now = ms;
    s.run.reportProgress({ progress, speed: 2, etaSec: 10, outTimeSec: progress * 100 });
  };

  at(1000, 0.1);
  at(1200, 0.2);
  at(1600, 0.3);
  at(1700, 1);

  expect(events.map((event) => event.progress)).toEqual([0.1, 0.3, 1]);
  expect(events[0]).toEqual({ jobId: s.row.id, step: 'encoding', progress: 0.1, speed: 2, etaSec: 10, outTimeSec: 10 });
  expect(s.live).toHaveLength(4);
  expect(getJobRow(s.t.ctx.db, s.row.id)?.progress).toBe(0);
  at(5100, 1);
  expect(getJobRow(s.t.ctx.db, s.row.id)).toMatchObject({ progress: 1, speed: 2, etaSec: 10 });
});

test('reportProgress - clamps and sanitises values', () => {
  const s = setup();
  s.clock.now = 10_000;
  s.run.reportProgress({ progress: 3 });
  s.run.reportProgress({ progress: Number.NaN });
  expect(s.live).toEqual([
    { progress: 1, speed: null, etaSec: null },
    { progress: 0, speed: null, etaSec: null },
  ]);
});

test('setStep - persists the step, logs a section and emits job.step', () => {
  const s = setup();
  const steps: EventMap['job.step'][] = [];
  s.t.ctx.events.on('job.step', (event) => steps.push(event));
  s.run.setStep('verifying', 'checking output');
  expect(getJobRow(s.t.ctx.db, s.row.id)?.step).toBe('verifying');
  expect(steps).toEqual([{ jobId: s.row.id, step: 'verifying', message: 'checking output' }]);
  expect(s.lines).toEqual(['== verifying: checking output']);
});

test('setTempPath - persists marked paths and refuses anything else', async () => {
  const s = setup();
  await s.run.setTempPath('/data/m/a.wololo-tmp.mkv');
  expect(getJobRow(s.t.ctx.db, s.row.id)?.tempPath).toBe('/data/m/a.wololo-tmp.mkv');
  await expect(s.run.setTempPath('/data/m/a.mkv')).rejects.toBeInstanceOf(AppError);
  await s.run.setTempPath(null);
  expect(getJobRow(s.t.ctx.db, s.row.id)?.tempPath).toBeNull();
});

test('ensureFreeSpace - passes with room, fails with precondition_failed when output + margin does not fit', async () => {
  const s = setup();
  await s.run.ensureFreeSpace(tmpdir(), 1024);
  const error = await s.run.ensureFreeSpace(tmpdir(), Number.MAX_SAFE_INTEGER).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('precondition_failed');
  expect(s.lines.some((line) => line.startsWith('free space in'))).toBe(true);
});

test('run - mirrors argv, stderr and the exit code into the job log', async () => {
  const s = setup();
  const result = await s.run.run({ command: 'sh', args: ['-c', 'echo oops >&2; exit 3'] });
  expect(result.exitCode).toBe(3);
  expect(s.lines[0]).toBe("$ sh -c 'echo oops >&2; exit 3'");
  expect(s.lines).toContain('oops');
  expect(s.lines.at(-1)).toMatch(/^exit 3 after/);
});

test('run - the job signal aborts the child', async () => {
  const s = setup();
  const pending = s.run.run({ command: 'sleep', args: ['10'] });
  s.controller.abort('cancel');
  const result = await pending;
  expect(result.aborted).toBe(true);
});
