import type { Settings } from '../../shared/settings.ts';

export type ProcessingWindow = Settings['processing']['window'];

function minutesOf(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Local wall-clock check (the container's TZ). start > end spans midnight ("22:00"-"06:00"); start == end means the
 * whole day. The end minute itself is outside the window.
 */
export function isWithinProcessingWindow(window: ProcessingWindow, now: Date): boolean {
  if (!window.enabled) return true;
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === end) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}
