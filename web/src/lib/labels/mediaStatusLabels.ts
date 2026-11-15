import type { MediaFileStatus } from '#lib/shared.ts';

export const MEDIA_STATUS_LABELS: Readonly<Record<MediaFileStatus, string>> = {
  pending: 'Pending',
  compatible: 'Compatible',
  needs_work: 'Needs work',
  blocked: 'Blocked',
  processing: 'Processing',
  failed: 'Failed',
  ignored: 'Ignored',
};
