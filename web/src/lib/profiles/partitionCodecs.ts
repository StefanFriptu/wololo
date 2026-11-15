import type { CodecInfo } from '#lib/shared.ts';

interface CodecPartition {
  /** Allowed codecs that the catalog lists (shown as checkboxes). */
  known: string[];
  /** Allowed entries the catalog does not list, wildcards included ("pcm_*"), kept as free text. */
  custom: string[];
}

export function partitionCodecs(allowed: readonly string[], catalog: readonly CodecInfo[]): CodecPartition {
  const listed = new Set(catalog.map((info) => info.codec));
  return {
    known: allowed.filter((codec) => listed.has(codec)),
    custom: allowed.filter((codec) => !listed.has(codec)),
  };
}
