import type { JobState } from '#lib/shared.ts';

export const JOB_STATE_LABELS: Readonly<Record<JobState, string>> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
