import type { MediaFileStatus, MediaQuery, MediaSortKey } from '#lib/shared.ts';

export interface MediaFilters extends MediaQuery {
  page: number;
  pageSize: number;
  sortKey: MediaSortKey;
  sortDir: 'asc' | 'desc';
  status?: MediaFileStatus;
}
