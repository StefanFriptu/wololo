import type { AppContext } from '../../app/context.ts';
import type { JobsService } from '../../contracts/jobs.ts';
import { notImplemented } from '../../core/errors.ts';
import type { QueueState } from '../../shared/domain.ts';

export function createJobsService(ctx: AppContext): JobsService {
  const idleState = (): QueueState => ({
    paused: false,
    pauseReasons: [],
    running: 0,
    queued: 0,
    concurrency: ctx.settings.section('processing').concurrency,
  });
  return {
    enqueue: async () => notImplemented('jobs.enqueue'),
    enqueueMany: async () => notImplemented('jobs.enqueueMany'),
    list: async () => notImplemented('jobs.list'),
    get: async () => notImplemented('jobs.get'),
    log: async () => notImplemented('jobs.log'),
    cancel: async () => notImplemented('jobs.cancel'),
    retry: async () => notImplemented('jobs.retry'),
    remove: async () => notImplemented('jobs.remove'),
    queue: async () => notImplemented('jobs.queue'),
    state: idleState,
    pause: () => notImplemented('jobs.pause'),
    resume: () => notImplemented('jobs.resume'),
    history: async () => notImplemented('jobs.history'),
    addHistory: async () => notImplemented('jobs.addHistory'),
    recover: async () => ({ requeued: 0, tempFilesDeleted: 0 }),
    housekeeping: async () => notImplemented('jobs.housekeeping'),
    start: async () => {},
    stop: async () => {},
  };
}
