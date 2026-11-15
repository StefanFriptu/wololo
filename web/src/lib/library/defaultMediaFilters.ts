import type { MediaFilters } from './MediaFilters.ts';

export const DEFAULT_MEDIA_FILTERS: Readonly<MediaFilters> = { page: 1, pageSize: 50, sortKey: 'path', sortDir: 'asc' };
