import type { LogEntry } from '#lib/shared.ts';
import type { LiveLogs } from './LiveLogs.ts';
import { mergeLogs } from './mergeLogs.ts';

type LiveLogsAction =
  | { type: 'snapshot'; entries: readonly LogEntry[] }
  | { type: 'entry'; entry: LogEntry }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reconnect' };

/** Log ids restart at 1 with every server process, so a reconnect drops what the view held instead of merging into it. */
export function updateLiveLogs(state: LiveLogs, action: LiveLogsAction, max: number): LiveLogs {
  switch (action.type) {
    case 'snapshot':
      return { ...state, entries: mergeLogs(state.entries, action.entries, max) };
    case 'entry':
      if (state.paused) return { ...state, buffered: [...state.buffered, action.entry].slice(-max) };
      return { ...state, entries: mergeLogs(state.entries, [action.entry], max) };
    case 'pause':
      return { ...state, paused: true };
    case 'resume':
      return { entries: mergeLogs(state.entries, state.buffered, max), buffered: [], paused: false };
    case 'reconnect':
      return { ...state, entries: [], buffered: [] };
  }
}
