import { DEFAULT_MEDIA_FILTERS } from './defaultMediaFilters.ts';
import type { MediaFilters } from './MediaFilters.ts';

const ORDER: readonly (keyof MediaFilters)[] = [
  'libraryId',
  'status',
  'kind',
  'profileId',
  'codec',
  'failingCodec',
  'search',
  'sortKey',
  'sortDir',
  'page',
  'pageSize',
];

/** URL search string ("?status=failed&page=2") for the filters, leaving out defaults; "" when everything is default. */
export function serializeMediaFilters(filters: Partial<MediaFilters>): string {
  const params = new URLSearchParams();
  for (const key of ORDER) {
    const value = filters[key];
    if (value === undefined || value === null || value === '') continue;
    if (key in DEFAULT_MEDIA_FILTERS && DEFAULT_MEDIA_FILTERS[key] === value) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
