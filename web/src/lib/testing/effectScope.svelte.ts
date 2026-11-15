import { flushSync } from 'svelte';

export function effectScope(setup: () => void): { flush: () => void; stop: () => void } {
  const stop = $effect.root(setup);
  flushSync();
  return { flush: flushSync, stop };
}
