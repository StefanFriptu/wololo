import type { HistoryEventType } from '#lib/shared.ts';

export const HISTORY_EVENT_LABELS: Readonly<Record<HistoryEventType, string>> = {
  queued: 'Queued',
  started: 'Started',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  retried: 'Retried',
  skipped: 'Skipped',
  recycled: 'Recycled',
  restored: 'Restored',
  purged: 'Purged',
  imported: 'Imported',
  source_deleted: 'Source deleted',
};
