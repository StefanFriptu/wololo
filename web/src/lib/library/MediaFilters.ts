import type { MediaFileStatus, MediaQuery, MediaSortKey, SortDir } from '#lib/shared.ts';
import type { MediaKindFilter } from './mediaKindFilterLabels.ts';

export interface MediaFilters extends MediaQuery {
  page: number;
  pageSize: number;
  sortKey: MediaSortKey;
  sortDir: SortDir;
  status?: MediaFileStatus;
  kind?: MediaKindFilter;
}
