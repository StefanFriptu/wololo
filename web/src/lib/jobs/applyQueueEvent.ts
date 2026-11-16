import type { JobSummary, ServerEvent } from '#lib/shared.ts';
import { patchJob } from './patchJob.ts';

function compareQueue(a: JobSummary, b: JobSummary): number {
  const running = Number(b.state === 'running') - Number(a.state === 'running');
  return running || b.priority - a.priority || a.id - b.id;
}

function upsert(items: readonly JobSummary[], job: JobSummary): JobSummary[] {
  const rest = items.filter((item) => item.id !== job.id);
  return [...rest, job].sort(compareQueue);
}

/** `truncated`: items is only the head of the queue, so a queued job that sorts after the last item is not shown. */
export function applyQueueEvent(
  items: readonly JobSummary[],
  event: ServerEvent,
  truncated = false,
): readonly JobSummary[] {
  switch (event.name) {
    case 'job.queued': {
      const last = items.at(-1);
      const beyondHead = truncated && last !== undefined && compareQueue(last, event.payload.job) < 0;
      const known = items.some((item) => item.id === event.payload.job.id);
      return beyondHead && !known ? items : upsert(items, event.payload.job);
    }
    case 'job.started':
      return upsert(items, event.payload.job);
    case 'job.finished':
      return items.filter((item) => item.id !== event.payload.job.id);
    case 'job.removed':
      return items.filter((item) => item.id !== event.payload.jobId);
    case 'job.progress':
    case 'job.step':
      return items.map((item) => patchJob(item, event));
    default:
      return items;
  }
}
