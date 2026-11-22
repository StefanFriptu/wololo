import { eq } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { SchedulerService, TaskDefinition } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import { type ScheduledTaskRow, scheduledTasks } from '../../db/schema.ts';
import type { ScheduledTaskInfo, TaskName } from '../../shared/domain.ts';
import { dueTasks, nextRunAt } from './schedule.ts';

export interface SchedulerOptions {
  tasks: readonly TaskDefinition[];
  now?: () => Date;
  /** How often due tasks are checked. Default 30 s. */
  tickMs?: number;
  /** Longest wait for running tasks on stop. Default 10 s (the whole shutdown is capped at 15 s). */
  stopTimeoutMs?: number;
}

interface RunningTask {
  controller: AbortController;
  done: Promise<void>;
}

export function createScheduler(ctx: AppContext, options: SchedulerOptions): SchedulerService {
  const log = ctx.logs.logger('scheduler');
  const now = options.now ?? (() => new Date());
  const definitions = new Map(options.tasks.map((task) => [task.name, task]));
  const running = new Map<TaskName, RunningTask>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  let seeded = false;

  const definition = (name: TaskName): TaskDefinition => {
    const task = definitions.get(name);
    if (!task) throw new AppError('not_found', `task ${name} not found`);
    return task;
  };

  const ensureRows = () => {
    if (seeded) return;
    const current = now();
    for (const task of options.tasks) {
      ctx.db
        .insert(scheduledTasks)
        .values({
          name: task.name,
          intervalMinutes: task.defaultIntervalMinutes,
          enabled: true,
          nextRunAt: nextRunAt({
            lastRunAt: null,
            intervalMinutes: task.defaultIntervalMinutes,
            enabled: true,
            now: current,
          }),
        })
        .onConflictDoNothing()
        .run();
    }
    seeded = true;
  };

  const rows = (): ScheduledTaskRow[] => {
    ensureRows();
    const all = ctx.db.select().from(scheduledTasks).all();
    return options.tasks
      .map((task) => all.find((row) => row.name === task.name))
      .filter((row): row is ScheduledTaskRow => row !== undefined);
  };

  const row = (name: TaskName): ScheduledTaskRow => {
    definition(name);
    ensureRows();
    const found = ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.name, name)).get();
    if (!found) throw new AppError('not_found', `task ${name} not found`);
    return found;
  };

  const toInfo = (task: ScheduledTaskRow): ScheduledTaskInfo => ({
    name: task.name,
    label: definition(task.name).label,
    intervalMinutes: task.intervalMinutes,
    enabled: task.enabled,
    running: running.has(task.name),
    lastRunAt: task.lastRunAt,
    lastDurationMs: task.lastDurationMs,
    lastResult: task.lastResult,
    lastMessage: task.lastMessage,
    nextRunAt: task.nextRunAt,
  });

  /** A run cut short by shutdown keeps its nextRunAt, so the task is due again right after the restart. */
  const record = (
    name: TaskName,
    startedAt: Date,
    result: 'success' | 'failure',
    message: string | null,
    reschedule: boolean,
  ) => {
    const current = row(name);
    const finishedAt = now();
    ctx.db
      .update(scheduledTasks)
      .set({
        lastRunAt: startedAt.toISOString(),
        lastDurationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        lastResult: result,
        lastMessage: message,
        nextRunAt: reschedule
          ? nextRunAt({
              lastRunAt: finishedAt.toISOString(),
              intervalMinutes: current.intervalMinutes,
              enabled: current.enabled,
              now: finishedAt,
            })
          : current.nextRunAt,
      })
      .where(eq(scheduledTasks.name, name))
      .run();
  };

  const execute = (name: TaskName) => {
    if (running.has(name)) return;
    const task = definition(name);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ctx.shutdownSignal]);
    const startedAt = now();
    const entry: RunningTask = { controller, done: Promise.resolve() };
    running.set(name, entry);
    entry.done = (async () => {
      ctx.events.emit('task.started', { name });
      log.info('task started', { task: name });
      let result: 'success' | 'failure' = 'success';
      let message: string | null = null;
      try {
        message = (await task.run(signal)) ?? null;
      } catch (error) {
        result = 'failure';
        message = errorMessage(error);
        log.error('task failed', { task: name, error: message });
      }
      try {
        const interrupted = result === 'failure' && (stopping || ctx.shutdownSignal.aborted);
        record(name, startedAt, result, message, !interrupted);
      } catch (error) {
        log.error('could not record task result', { task: name, error: errorMessage(error) });
      }
      running.delete(name);
      if (result === 'success') log.info('task finished', { task: name, message });
      try {
        ctx.events.emit('task.finished', { task: toInfo(row(name)) });
      } catch (error) {
        log.error('could not report task result', { task: name, error: errorMessage(error) });
      }
    })();
  };

  const tick = () => {
    if (ctx.shutdownSignal.aborted) return;
    try {
      for (const name of dueTasks(rows(), now(), new Set(running.keys()))) execute(name);
    } catch (error) {
      log.error('scheduler tick failed', { error: errorMessage(error) });
    }
  };

  return {
    list: async () => rows().map(toInfo),

    runNow: async (name) => {
      row(name);
      execute(name);
      return toInfo(row(name));
    },

    update: async (name, patch) => {
      const current = row(name);
      const intervalMinutes = patch.intervalMinutes ?? current.intervalMinutes;
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1)
        throw new AppError('validation', 'intervalMinutes must be a whole number of minutes >= 1');
      const enabled = patch.enabled ?? current.enabled;
      ctx.db
        .update(scheduledTasks)
        .set({
          intervalMinutes,
          enabled,
          nextRunAt: nextRunAt({ lastRunAt: current.lastRunAt, intervalMinutes, enabled, now: now() }),
        })
        .where(eq(scheduledTasks.name, name))
        .run();
      return toInfo(row(name));
    },

    start: async () => {
      if (timer) return;
      stopping = false;
      ensureRows();
      timer = setInterval(tick, options.tickMs ?? 30_000);
      timer.unref?.();
      tick();
    },

    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      const pending = [...running.values()];
      for (const task of pending) task.controller.abort();
      const cap = new Promise<void>((resolve) => setTimeout(resolve, options.stopTimeoutMs ?? 10_000).unref?.());
      await Promise.race([Promise.all(pending.map((task) => task.done)), cap]);
    },
  };
}
