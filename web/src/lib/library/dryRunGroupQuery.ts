/** Library list query for one dry-run group; video and "blocked" groups list blocked files, disc work both disc kinds. */
export function dryRunGroupQuery(codec: string, libraryId: number | undefined): string {
  const query = (status: 'needs_work' | 'blocked', extra: Record<string, string> = {}): string => {
    const params = new URLSearchParams({ status, ...extra });
    if (libraryId !== undefined) params.set('libraryId', String(libraryId));
    return `?${params}`;
  };
  if (codec === 'bdmv') return query('needs_work', { kind: 'bdmv,iso' });
  if (codec === 'blocked') return query('blocked');
  if (codec.startsWith('video:')) return query('blocked', { codec: codec.slice('video:'.length) });
  return query('needs_work', { failingCodec: codec });
}
