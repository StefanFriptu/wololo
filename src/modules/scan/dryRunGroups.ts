import type { MediaFileKind, PlanAction } from '../../shared/domain.ts';

export interface GroupableRow {
  kind: MediaFileKind;
  planAction: PlanAction | null;
  failingCodecs: readonly string[];
  videoCodec: string | null;
}

/**
 * Pure: dry-run groups a row counts towards. Discs -> "bdmv"; blocked rows name their video codec as "video:<codec>";
 * work without a failing codec (language cleanup, flags) -> "remux".
 */
export function dryRunGroupKeys(row: GroupableRow): string[] {
  if (row.kind !== 'file') return ['bdmv'];
  const video = row.videoCodec?.toLowerCase() ?? null;
  const keys = new Set<string>();
  for (const codec of row.failingCodecs.map((value) => value.toLowerCase())) {
    keys.add(row.planAction === 'blocked' && codec === video ? `video:${codec}` : codec);
  }
  if (row.planAction === 'blocked' && video && keys.size === 0) keys.add(`video:${video}`);
  if (keys.size === 0) keys.add(row.planAction === 'blocked' ? 'blocked' : 'remux');
  return [...keys];
}
