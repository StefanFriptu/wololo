const MAX_RECONNECT_DELAY_MS = 30_000;

/** Exponential back-off for the event stream: 1 s, 2 s, 4 s ... capped at 30 s. */
export function reconnectDelay(attempt: number): number {
  const safe = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(safe, 15));
}
