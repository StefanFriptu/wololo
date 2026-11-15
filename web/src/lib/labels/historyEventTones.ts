import type { HistoryEventType } from '#lib/shared.ts';
import type { Tone } from './Tone.ts';

export const HISTORY_EVENT_TONES: Readonly<Record<HistoryEventType, Tone>> = {
  queued: 'neutral',
  started: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  retried: 'info',
  skipped: 'neutral',
  recycled: 'neutral',
  restored: 'warning',
  purged: 'neutral',
  imported: 'success',
  source_deleted: 'warning',
};
