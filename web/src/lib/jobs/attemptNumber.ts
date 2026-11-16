import type { JobSummary } from '#lib/shared.ts';

/** `attempts` counts started attempts, so a queued job is about to start the next one. */
export function attemptNumber(job: Pick<JobSummary, 'state' | 'attempts'>): number {
  return job.state === 'queued' ? job.attempts + 1 : Math.max(1, job.attempts);
}
