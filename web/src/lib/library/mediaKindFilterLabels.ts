import type { MediaFileKind } from '#lib/shared.ts';

export type MediaKindFilter = MediaFileKind | 'bdmv,iso';

export const MEDIA_KIND_FILTER_LABELS: Readonly<Record<MediaKindFilter, string>> = {
  file: 'File',
  bdmv: 'Blu-ray folder',
  iso: 'Blu-ray ISO',
  'bdmv,iso': 'Blu-ray (folder or ISO)',
};
