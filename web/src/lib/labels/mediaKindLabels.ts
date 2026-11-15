import type { MediaFileKind } from '#lib/shared.ts';

export const MEDIA_KIND_LABELS: Readonly<Record<MediaFileKind, string>> = {
  file: 'File',
  bdmv: 'Blu-ray folder',
  iso: 'Blu-ray ISO',
};
