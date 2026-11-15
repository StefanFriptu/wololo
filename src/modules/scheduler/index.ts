import type { AppContext } from '../../app/context.ts';
import type { SchedulerService } from '../../contracts/probe-scan.ts';
import { notImplemented } from '../../core/errors.ts';

export function createSchedulerService(_ctx: AppContext): SchedulerService {
  return {
    list: async () => notImplemented('scheduler.list'),
    runNow: async () => notImplemented('scheduler.runNow'),
    update: async () => notImplemented('scheduler.update'),
    start: async () => {},
    stop: async () => {},
  };
}
