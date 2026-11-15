import type { EnqueueFilter, MediaFileKind, MediaQuery } from '#lib/shared.ts';

interface NeedsWorkScopeInput {
  filters: Pick<MediaQuery, 'libraryId' | 'profileId' | 'failingCodec' | 'kind' | 'codec' | 'search' | 'status'>;
  libraryName: string | null;
  profileName: string | null;
  kindLabels: Readonly<Record<MediaFileKind, string>>;
  listedTotal: number | null;
}

type NeedsWorkScope = { ok: true; filter: EnqueueFilter; question: string } | { ok: false; reason: string };

export function needsWorkScope({
  filters,
  libraryName,
  profileName,
  kindLabels,
  listedTotal,
}: NeedsWorkScopeInput): NeedsWorkScope {
  const unsupported = [filters.search && 'search', filters.codec && 'codec'].filter(Boolean);
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `The ${unsupported.join(' and ')} filter cannot be applied to bulk processing. Select the files and use "Process selected".`,
    };
  }
  const filter: EnqueueFilter = {
    status: 'needs_work',
    libraryId: filters.libraryId,
    failingCodec: filters.failingCodec,
    kind: filters.kind,
    profileId: filters.profileId,
  };
  const known = filters.status === 'needs_work' && listedTotal !== null;
  const parts = [
    known ? `Queue all ${listedTotal} file(s) that need work` : 'Queue every file that needs work',
    filters.libraryId === undefined ? 'in every library' : `in ${libraryName ?? `library #${filters.libraryId}`}`,
    filters.kind && `of type ${kindLabels[filters.kind]}`,
    filters.failingCodec && `failing on ${filters.failingCodec}`,
    filters.profileId !== undefined && `checked against profile ${profileName ?? `#${filters.profileId}`}`,
  ];
  return { ok: true, filter, question: `${parts.filter(Boolean).join(' ')}?` };
}
