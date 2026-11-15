import { expect, test } from 'bun:test';
import { jobFixture } from '#lib/testing/jobFixture.ts';
import { patchJob } from './patchJob.ts';

test('patchJob - progress updates step, progress, speed and ETA and marks the job running', () => {
  const job = jobFixture();
  const next = patchJob(job, {
    name: 'job.progress',
    payload: { jobId: 1, step: 'encoding', progress: 0.5, speed: 7.7, etaSec: 120, outTimeSec: 600 },
  });
  expect(next).toMatchObject({ state: 'running', step: 'encoding', progress: 0.5, speed: 7.7, etaSec: 120 });
});

test('patchJob - events about another job return the same object', () => {
  const job = jobFixture();
  const next = patchJob(job, { name: 'job.step', payload: { jobId: 2, step: 'verifying', message: null } });
  expect(next).toBe(job);
});

test('patchJob - step event changes only the step', () => {
  const job = jobFixture({ state: 'running', progress: 0.9 });
  const next = patchJob(job, { name: 'job.step', payload: { jobId: 1, step: 'verifying', message: 'checking' } });
  expect(next).toEqual({ ...job, step: 'verifying' });
});

test('patchJob - finished replaces the job with the payload', () => {
  const finished = jobFixture({ state: 'completed', step: 'done', progress: 1 });
  const next = patchJob(jobFixture(), { name: 'job.finished', payload: { job: finished, state: 'completed' } });
  expect(next).toBe(finished);
});

test('patchJob - unrelated events are ignored', () => {
  const job = jobFixture();
  expect(patchJob(job, { name: 'media.removed', payload: { mediaFileId: 10 } })).toBe(job);
});
