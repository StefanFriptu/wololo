import type { JobSummary, ServerEvent } from '#lib/shared.ts';

export function patchJob(job: JobSummary, event: ServerEvent): JobSummary {
  switch (event.name) {
    case 'job.queued':
    case 'job.started':
    case 'job.finished':
      return event.payload.job.id === job.id ? event.payload.job : job;
    case 'job.progress': {
      const { jobId, step, progress, speed, etaSec } = event.payload;
      if (jobId !== job.id) return job;
      return { ...job, state: 'running', step, progress, speed, etaSec };
    }
    case 'job.step':
      return event.payload.jobId === job.id ? { ...job, step: event.payload.step } : job;
    default:
      return job;
  }
}
