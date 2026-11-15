import {
  MEDIA_FILE_KINDS,
  MEDIA_FILE_STATUSES,
  type MediaFileKind,
  type MediaFileStatus,
  type MediaSortKey,
} from '#lib/shared.ts';
import { DEFAULT_MEDIA_FILTERS } from './defaultMediaFilters.ts';
import type { MediaFilters } from './MediaFilters.ts';
import { PAGE_SIZES } from './pageSizes.ts';

const MEDIA_SORT_KEYS: readonly MediaSortKey[] = ['path', 'size', 'status', 'updatedAt', 'duration'];

const positiveInt = (value: string | null): number | undefined => {
  if (value == null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
};

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

const text = (value: string | null): string | undefined => value?.trim() || undefined;

/** Library filters from the page URL; anything invalid falls back to the default. */
export function parseMediaFilters(params: Pick<URLSearchParams, 'get'>): MediaFilters {
  const pageSize = positiveInt(params.get('pageSize'));
  const filters: MediaFilters = {
    page: positiveInt(params.get('page')) ?? DEFAULT_MEDIA_FILTERS.page,
    pageSize: pageSize !== undefined && PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_MEDIA_FILTERS.pageSize,
    sortKey: oneOf(MEDIA_SORT_KEYS, params.get('sortKey')) ?? DEFAULT_MEDIA_FILTERS.sortKey,
    sortDir: oneOf(['asc', 'desc'] as const, params.get('sortDir')) ?? DEFAULT_MEDIA_FILTERS.sortDir,
    status: oneOf<MediaFileStatus>(MEDIA_FILE_STATUSES, params.get('status')),
    kind: oneOf<MediaFileKind>(MEDIA_FILE_KINDS, params.get('kind')),
    libraryId: positiveInt(params.get('libraryId')),
    profileId: positiveInt(params.get('profileId')),
    codec: text(params.get('codec'))?.toLowerCase(),
    failingCodec: text(params.get('failingCodec'))?.toLowerCase(),
    search: text(params.get('search')),
  };
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as MediaFilters;
}
