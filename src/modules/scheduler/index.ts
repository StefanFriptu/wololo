import type { AppContext } from '../../app/context.ts';
import type { SchedulerService } from '../../contracts/probe-scan.ts';
import { createScheduler } from './scheduler.ts';
import { taskDefinitions } from './tasks.ts';

export function createSchedulerService(ctx: AppContext): SchedulerService {
  return createScheduler(ctx, { tasks: taskDefinitions(ctx) });
}
