import type { EnqueueFilter } from '#lib/shared.ts';
import type { MediaFilters } from './MediaFilters.ts';
import { MEDIA_KIND_FILTER_LABELS } from './mediaKindFilterLabels.ts';

interface NeedsWorkScopeInput {
  filters: Pick<MediaFilters, 'libraryId' | 'profileId' | 'failingCodec' | 'kind' | 'codec' | 'search' | 'status'>;
  libraryName: string | null;
  profileName: string | null;
  listedTotal: number | null;
}

interface NeedsWorkScope {
  filter: EnqueueFilter;
  question: string;
}

export function needsWorkScope({
  filters,
  libraryName,
  profileName,
  listedTotal,
}: NeedsWorkScopeInput): NeedsWorkScope {
  const filter: EnqueueFilter = {
    status: 'needs_work',
    libraryId: filters.libraryId,
    failingCodec: filters.failingCodec,
    kind: filters.kind,
    profileId: filters.profileId,
    search: filters.search,
    codec: filters.codec,
  };
  const known = filters.status === 'needs_work' && listedTotal !== null;
  const parts = [
    known ? `Queue all ${listedTotal} file(s) that need work` : 'Queue every file that needs work',
    filters.libraryId === undefined ? 'in every library' : `in ${libraryName ?? `library #${filters.libraryId}`}`,
    filters.kind && `of type ${MEDIA_KIND_FILTER_LABELS[filters.kind]}`,
    filters.failingCodec && `failing on ${filters.failingCodec}`,
    filters.codec && `with a ${filters.codec} stream`,
    filters.search && `matching "${filters.search}"`,
    filters.profileId !== undefined && `checked against profile ${profileName ?? `#${filters.profileId}`}`,
  ];
  return { filter, question: `${parts.filter(Boolean).join(' ')}?` };
}
