import type { LogEntry } from '#lib/shared.ts';

/** Adds entries (from a poll or SSE) to the list, de-duplicated by id, oldest first, keeping the newest `max`. */
export function mergeLogs(existing: readonly LogEntry[], incoming: readonly LogEntry[], max: number): LogEntry[] {
  const byId = new Map<number, LogEntry>();
  for (const entry of [...existing, ...incoming]) byId.set(entry.id, entry);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return max > 0 ? merged.slice(-max) : [];
}
