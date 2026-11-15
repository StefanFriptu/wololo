import type { MediaFileKind } from '#lib/shared.ts';

interface DryRunGroupLink {
  label: string;
  query: string;
}

const DISC_KINDS: readonly { kind: MediaFileKind; label: string }[] = [
  { kind: 'bdmv', label: 'folders' },
  { kind: 'iso', label: 'ISOs' },
];

/** Library list links for one dry-run group; disc work spans two kinds, and the list filters on one kind at a time. */
export function dryRunGroupLinks(codec: string, libraryId: number | undefined): DryRunGroupLink[] {
  const query = (extra: Record<string, string>): string => {
    const params = new URLSearchParams({ status: 'needs_work', ...extra });
    if (libraryId !== undefined) params.set('libraryId', String(libraryId));
    return `?${params}`;
  };
  if (codec === 'bdmv') return DISC_KINDS.map(({ kind, label }) => ({ label, query: query({ kind }) }));
  if (codec.startsWith('video:')) return [{ label: codec, query: query({ codec: codec.slice('video:'.length) }) }];
  return [{ label: codec, query: query({ failingCodec: codec }) }];
}
