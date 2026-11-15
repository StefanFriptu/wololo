import type { JobStep } from '#lib/shared.ts';

export const JOB_STEP_LABELS: Readonly<Record<JobStep, string>> = {
  waiting: 'Waiting',
  preparing: 'Preparing',
  encoding: 'Encoding',
  muxing: 'Muxing',
  verifying: 'Verifying',
  replacing: 'Replacing',
  importing: 'Importing',
  notifying: 'Notifying',
  done: 'Done',
};
