import type { QueuePauseReason } from '#lib/shared.ts';

export const PAUSE_REASON_LABELS: Readonly<Record<QueuePauseReason, string>> = {
  user: 'Paused by you',
  dry_run: 'Processing is off (dry run)',
  window: 'Outside the processing window',
  plex_streaming: 'Plex is streaming',
  low_disk_space: 'Waiting for free disk space',
  shutdown: 'Shutting down',
};
