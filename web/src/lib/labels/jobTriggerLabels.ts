import type { JobTrigger } from '#lib/shared.ts';

export const JOB_TRIGGER_LABELS: Readonly<Record<JobTrigger, string>> = {
  webhook: 'Import',
  scan: 'Scan',
  manual: 'Manual',
  retry: 'Retry',
  recovery: 'Recovery',
};
