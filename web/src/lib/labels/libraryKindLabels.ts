import type { LibraryKind } from '#lib/shared.ts';

export const LIBRARY_KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  movies: 'Movies',
  series: 'Series',
  other: 'Other',
};
