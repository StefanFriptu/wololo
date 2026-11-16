export interface PageVisibility {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Runs `start` while the page is visible and calls the stop function it returns when the page is hidden.
 * `resumed` is true for every start after the first. Returns a function that stops for good.
 */
export function visibleOnly(page: PageVisibility | null, start: (resumed: boolean) => () => void): () => void {
  let stop: (() => void) | null = null;
  let started = false;
  const sync = (): void => {
    if (page?.visibilityState === 'hidden') {
      stop?.();
      stop = null;
      return;
    }
    if (stop) return;
    stop = start(started);
    started = true;
  };
  page?.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    page?.removeEventListener('visibilitychange', sync);
    stop?.();
    stop = null;
  };
}
