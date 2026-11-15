import type { LibraryMode } from '#lib/shared.ts';

export const LIBRARY_MODE_LABELS: Readonly<Record<LibraryMode, string>> = {
  replace: 'Replace',
  keep_both: 'Keep both',
};
