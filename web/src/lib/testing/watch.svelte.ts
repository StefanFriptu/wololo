import { flushSync } from 'svelte';

export function watch<T>(read: () => T, onRun: (value: T) => void): () => void {
  const stop = $effect.root(() => {
    $effect(() => {
      onRun(read());
    });
  });
  flushSync();
  return stop;
}
