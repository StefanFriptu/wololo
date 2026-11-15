import { afterEach, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { DEFAULT_TASK_INTERVALS, type SchedulerService, type TaskDefinition } from '../../contracts/probe-scan.ts';
import { AppError } from '../../core/errors.ts';
import { scheduledTasks } from '../../db/schema.ts';
import type { TaskName } from '../../shared/domain.ts';
import type { EventMap } from '../../shared/events.ts';
import { createScheduler } from './scheduler.ts';

let t: TestContext;
let clock: Date;
let runs: TaskName[];
let behaviour: Partial<Record<TaskName, (signal: AbortSignal) => Promise<string | undefined>>>;
let scheduler: SchedulerService;

const tasks = (): TaskDefinition[] =>
  (Object.keys(DEFAULT_TASK_INTERVALS) as TaskName[]).map((name) => ({
    name,
    label: `Task ${name}`,
    defaultIntervalMinutes: DEFAULT_TASK_INTERVALS[name],
    run: async (signal) => {
      runs.push(name);
      return (await behaviour[name]?.(signal)) ?? `${name} done`;
    },
  }));

function finished(name: TaskName): Promise<EventMap['task.finished']> {
  return new Promise((resolve) => {
    const off = t.ctx.events.on('task.finished', (payload) => {
      if (payload.task.name !== name) return;
      off();
      resolve(payload);
    });
  });
}

beforeEach(() => {
  t = createTestContext();
  clock = new Date('2026-11-15T12:00:00.000Z');
  runs = [];
  behaviour = {};
  scheduler = createScheduler(t.ctx, { tasks: tasks(), now: () => clock, tickMs: 5, stopTimeoutMs: 200 });
});

afterEach(async () => {
  await scheduler.stop();
  t.cleanup();
});

test('scheduler.list - seeds every task with its default interval, first run one interval away', async () => {
  const list = await scheduler.list();
  expect(list.map((task) => task.name)).toEqual(Object.keys(DEFAULT_TASK_INTERVALS) as TaskName[]);
  expect(list[0]).toEqual({
    name: 'library_scan',
    label: 'Task library_scan',
    intervalMinutes: 360,
    enabled: true,
    running: false,
    lastRunAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastMessage: null,
    nextRunAt: '2026-11-15T18:00:00.000Z',
  });
});

test('scheduler.runNow - runs in the background and records success', async () => {
  const done = finished('housekeeping');
  const started: TaskName[] = [];
  t.ctx.events.on('task.started', ({ name }) => started.push(name));
  const info = await scheduler.runNow('housekeeping');
  expect(info.running).toBe(true);
  const result = (await done).task;
  expect(started).toEqual(['housekeeping']);
  expect(result).toMatchObject({
    name: 'housekeeping',
    running: false,
    lastRunAt: '2026-11-15T12:00:00.000Z',
    lastResult: 'success',
    lastMessage: 'housekeeping done',
    lastDurationMs: 0,
    nextRunAt: '2026-11-16T12:00:00.000Z',
  });
});

test('scheduler.runNow - a failing task records the error message', async () => {
  behaviour.backup = async () => {
    throw new AppError('upstream', 'backup disk full');
  };
  const done = finished('backup');
  await scheduler.runNow('backup');
  expect((await done).task).toMatchObject({
    lastResult: 'failure',
    lastMessage: 'backup disk full',
  });
});

test('scheduler.runNow - a running task is not started twice', async () => {
  let release: () => void = () => {};
  behaviour.seeding_check = () => new Promise((resolve) => (release = () => resolve('ok')));
  const done = finished('seeding_check');
  await scheduler.runNow('seeding_check');
  const again = await scheduler.runNow('seeding_check');
  expect(again.running).toBe(true);
  release();
  await done;
  expect(runs).toEqual(['seeding_check']);
});

test('scheduler.start - runs due tasks on the tick, overdue ones right away', async () => {
  await scheduler.list();
  t.ctx.db
    .update(scheduledTasks)
    .set({ nextRunAt: '2026-11-15T11:00:00.000Z' })
    .where(eq(scheduledTasks.name, 'log_cleanup'))
    .run();
  const overdue = finished('log_cleanup');
  await scheduler.start();
  await overdue;
  expect(runs).toEqual(['log_cleanup']);

  clock = new Date('2026-11-15T13:00:00.000Z');
  const purge = finished('recycle_bin_purge');
  await purge;
  expect(runs).toContain('recycle_bin_purge');
  expect(runs).not.toContain('library_scan');
});

test('scheduler.update - interval and enabled change the next run; invalid values are rejected', async () => {
  const disabled = await scheduler.update('backup', { enabled: false });
  expect(disabled).toMatchObject({ enabled: false, nextRunAt: null });
  const enabled = await scheduler.update('backup', { enabled: true, intervalMinutes: 30 });
  expect(enabled).toMatchObject({ enabled: true, intervalMinutes: 30, nextRunAt: '2026-11-15T12:30:00.000Z' });
  const error = await scheduler.update('backup', { intervalMinutes: 0 }).catch((caught: unknown) => caught);
  expect((error as AppError).code).toBe('validation');
});

test('scheduler - unknown task names are not_found', async () => {
  const error = await scheduler.runNow('nope' as TaskName).catch((caught: unknown) => caught);
  expect((error as AppError).code).toBe('not_found');
});

test('scheduler.stop - aborts running tasks and records them without moving their next run', async () => {
  behaviour.library_scan = (signal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const before = (await scheduler.list()).find((task) => task.name === 'library_scan');
  const done = finished('library_scan');
  await scheduler.runNow('library_scan');
  clock = new Date(clock.getTime() + 60_000);
  await scheduler.stop();
  expect((await done).task).toMatchObject({
    lastResult: 'failure',
    lastMessage: 'aborted',
    nextRunAt: before?.nextRunAt ?? 'missing',
  });
});

test('scheduler - a failed run outside shutdown is rescheduled one interval after it finished', async () => {
  behaviour.library_scan = async () => {
    throw new Error('boom');
  };
  const done = finished('library_scan');
  await scheduler.runNow('library_scan');
  expect((await done).task).toMatchObject({
    lastResult: 'failure',
    nextRunAt: new Date(clock.getTime() + 360 * 60_000).toISOString(),
  });
});
