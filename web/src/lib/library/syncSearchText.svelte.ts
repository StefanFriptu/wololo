import { untrack } from 'svelte';

interface SearchTextSync {
  urlSearch: () => string | undefined;
  read: () => string;
  write: (text: string) => void;
}

/** Copies the URL's search into the input when the URL changes from outside (sidebar link, back/forward). */
export function syncSearchText({ urlSearch, read, write }: SearchTextSync): void {
  $effect(() => {
    const fromUrl = urlSearch() ?? '';
    untrack(() => {
      if (fromUrl !== read().trim()) write(fromUrl);
    });
  });
}
