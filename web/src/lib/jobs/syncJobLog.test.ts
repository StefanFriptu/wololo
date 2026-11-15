import { afterEach, expect, test } from 'bun:test';
import type { JobDetail } from '#lib/shared.ts';
import { compileRunes } from '#lib/testing/compileRunes.ts';
import { jobFixture } from '#lib/testing/jobFixture.ts';

compileRunes();
const { Resource } = await import('#lib/resource.svelte.ts');
const { effectScope } = await import('#lib/testing/effectScope.svelte.ts');
const { syncJobLog } = await import('./syncJobLog.svelte.ts');

const POLL_MS = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const detail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  ...jobFixture({ state: 'running', step: 'encoding' }),
  plan: null,
  bdmvPlan: null,
  before: null,
  after: null,
  lostFeatures: [],
  verification: null,
  bytesBefore: null,
  bytesAfter: null,
  hasLog: true,
  recycleBinEntryId: null,
  ...overrides,
});

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

function setup(initial: JobDetail, fetched: JobDetail = initial, logDelayMs = 0) {
  const calls = { job: 0, log: 0, logDone: 0 };
  const job = new Resource<JobDetail>(async () => {
    calls.job += 1;
    return fetched;
  });
  const log = new Resource<string>(async () => {
    calls.log += 1;
    await sleep(logDelayMs);
    calls.logDone += 1;
    return `line ${calls.log}`;
  });
  job.set(initial);
  const scope = effectScope(() => syncJobLog(job, log, POLL_MS));
  stops.push(scope.stop);
  return { calls, job, log, flush: scope.flush };
}

test('syncJobLog - progress updates do not refetch the log', async () => {
  const { calls, job, flush } = setup(detail());
  expect(calls.log).toBe(1);
  for (let tick = 1; tick <= 10; tick += 1) {
    const current = job.data;
    if (current) job.set({ ...current, progress: tick / 10 });
    flush();
  }
  expect(calls.log).toBe(1);
});

test('syncJobLog - polls the log on the timer while the job runs', async () => {
  const { calls } = setup(detail());
  await sleep(POLL_MS * 3.5);
  expect(calls.log).toBeGreaterThanOrEqual(3);
  expect(calls.log).toBeLessThanOrEqual(5);
});

test('syncJobLog - a slow log request is not aborted by the next tick', async () => {
  const { calls, log } = setup(detail(), detail(), POLL_MS * 3);
  await sleep(POLL_MS * 4);
  expect(calls.logDone).toBeGreaterThanOrEqual(1);
  expect(log.data).toBe('line 1');
});

test('syncJobLog - reloads the job detail until the log exists, then loads the log', async () => {
  const { calls, job, flush } = setup(detail({ hasLog: false }), detail({ hasLog: true }));
  expect(calls.log).toBe(0);
  await sleep(POLL_MS * 1.5);
  flush();
  expect(calls.job).toBeGreaterThanOrEqual(1);
  expect(job.data?.hasLog).toBe(true);
  expect(calls.log).toBe(1);
});

test('syncJobLog - loads the final log once the job finishes and stops polling', async () => {
  const { calls, job, flush } = setup(detail());
  const current = job.data;
  if (current) job.set({ ...current, state: 'completed' });
  flush();
  expect(calls.log).toBe(2);
  await sleep(POLL_MS * 3);
  expect(calls.log).toBe(2);
});

test('syncJobLog - a queued job without a log fetches nothing', async () => {
  const { calls } = setup(detail({ state: 'queued', hasLog: false }));
  await sleep(POLL_MS * 2);
  expect(calls).toEqual({ job: 0, log: 0, logDone: 0 });
});
