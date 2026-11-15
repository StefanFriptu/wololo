/**
 * Settles with `fallback` when `work` takes longer than `ms`. The work itself keeps running: a filesystem call on a
 * hung network mount cannot be cancelled, but the event loop is no longer waiting for it.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
