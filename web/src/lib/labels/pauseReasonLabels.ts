import type { QueuePauseReason } from '#lib/shared.ts';

export const PAUSE_REASON_LABELS: Readonly<Record<QueuePauseReason, string>> = {
  user: 'Paused by you',
  window: 'Outside the processing window',
  plex_streaming: 'Plex is streaming',
  shutdown: 'Shutting down',
};
