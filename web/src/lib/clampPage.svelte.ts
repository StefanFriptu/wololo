import { untrack } from 'svelte';
import { pageInRange } from '#lib/pageInRange.ts';
import type { Paginated } from '#lib/shared.ts';

/** Jumps to the last page when the loaded result says the current page is past the end (rows deleted meanwhile). */
export function clampPage(
  result: () => Pick<Paginated<unknown>, 'page' | 'pageSize' | 'total' | 'items'> | undefined,
  setPage: (page: number) => void,
): void {
  $effect(() => {
    const loaded = result();
    const target = loaded ? pageInRange(loaded) : null;
    if (target !== null) untrack(() => setPage(target));
  });
}
