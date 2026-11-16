import { expect, test } from 'bun:test';
import { jobFixture } from '#lib/testing/jobFixture.ts';
import { applyQueueEvent } from './applyQueueEvent.ts';

const ids = (items: readonly { id: number }[]): number[] => items.map((item) => item.id);

test('applyQueueEvent - queued job is appended behind running and higher-priority jobs', () => {
  const items = [jobFixture({ id: 1, state: 'running' }), jobFixture({ id: 2, priority: 5 })];
  const next = applyQueueEvent(items, { name: 'job.queued', payload: { job: jobFixture({ id: 3 }) } });
  expect(ids(next)).toEqual([1, 2, 3]);
});

test('applyQueueEvent - started job moves to the top and replaces its queued copy', () => {
  const items = [jobFixture({ id: 1 }), jobFixture({ id: 2 })];
  const next = applyQueueEvent(items, {
    name: 'job.started',
    payload: { job: jobFixture({ id: 2, state: 'running', step: 'preparing' }) },
  });
  expect(ids(next)).toEqual([2, 1]);
  expect(next[0]?.state).toBe('running');
});

test('applyQueueEvent - progress patches only the matching job', () => {
  const items = [jobFixture({ id: 1, state: 'running' }), jobFixture({ id: 2 })];
  const next = applyQueueEvent(items, {
    name: 'job.progress',
    payload: { jobId: 1, step: 'encoding', progress: 0.25, speed: 3, etaSec: 300, outTimeSec: 100 },
  });
  expect(next[0]?.progress).toBe(0.25);
  expect(next[1]).toBe(items[1]);
});

test.each([
  ['job.finished', { name: 'job.finished', payload: { job: jobFixture({ id: 1, state: 'failed' }), state: 'failed' } }],
  ['job.removed', { name: 'job.removed', payload: { jobId: 1 } }],
] as const)('applyQueueEvent - %s removes the job', (_, event) => {
  const items = [jobFixture({ id: 1 }), jobFixture({ id: 2 })];
  expect(ids(applyQueueEvent(items, event))).toEqual([2]);
});

test('applyQueueEvent - unrelated events return the same array', () => {
  const items = [jobFixture()];
  expect(applyQueueEvent(items, { name: 'settings.changed', payload: { sections: ['processing'] } })).toBe(items);
});

test('applyQueueEvent - equal priority keeps id order', () => {
  const items = [jobFixture({ id: 5 })];
  const next = applyQueueEvent(items, { name: 'job.queued', payload: { job: jobFixture({ id: 4 }) } });
  expect(ids(next)).toEqual([4, 5]);
});

test('applyQueueEvent - truncated list ignores a queued job that sorts after its last item', () => {
  const items = [jobFixture({ id: 1, state: 'running' }), jobFixture({ id: 2 })];
  const event = { name: 'job.queued', payload: { job: jobFixture({ id: 3 }) } } as const;
  expect(applyQueueEvent(items, event, true)).toBe(items);
  expect(ids(applyQueueEvent(items, event, false))).toEqual([1, 2, 3]);
});

test('applyQueueEvent - truncated list still takes a queued job that sorts inside it', () => {
  const items = [jobFixture({ id: 1, state: 'running' }), jobFixture({ id: 2 })];
  const next = applyQueueEvent(
    items,
    { name: 'job.queued', payload: { job: jobFixture({ id: 3, priority: 5 }) } },
    true,
  );
  expect(ids(next)).toEqual([1, 3, 2]);
});
