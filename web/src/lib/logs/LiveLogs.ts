import type { LogEntry } from '#lib/shared.ts';

export interface LiveLogs {
  entries: readonly LogEntry[];
  buffered: readonly LogEntry[];
  paused: boolean;
}
