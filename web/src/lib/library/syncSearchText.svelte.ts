import { untrack } from 'svelte';

interface SearchTextSync {
  urlSearch: () => string | undefined;
  read: () => string;
  write: (text: string) => void;
}

interface SearchTextPush {
  markPushed: (text: string) => void;
}

/**
 * Copies the URL's search into the input when the URL changes from outside (sidebar link, back/forward).
 * The first URL change after `markPushed` is skipped when it echoes the pushed text, because the user may have
 * typed on while that navigation was in flight.
 */
export function syncSearchText({ urlSearch, read, write }: SearchTextSync): SearchTextPush {
  let pending: string | undefined;
  $effect(() => {
    const fromUrl = urlSearch() ?? '';
    if (pending !== undefined) {
      const echo = pending === fromUrl;
      pending = undefined;
      if (echo) return;
    }
    untrack(() => {
      if (fromUrl !== read().trim()) write(fromUrl);
    });
  });
  return {
    markPushed: (text) => {
      pending = text;
    },
  };
}
