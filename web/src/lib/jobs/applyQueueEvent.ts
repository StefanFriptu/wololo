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

export function applyQueueEvent(items: readonly JobSummary[], event: ServerEvent): readonly JobSummary[] {
  switch (event.name) {
    case 'job.queued':
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
