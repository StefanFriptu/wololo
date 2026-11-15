import type { MediaFileStatus } from '#lib/shared.ts';
import type { Tone } from './Tone.ts';

export const MEDIA_STATUS_TONES: Readonly<Record<MediaFileStatus, Tone>> = {
  pending: 'neutral',
  compatible: 'success',
  needs_work: 'warning',
  processing: 'info',
  failed: 'danger',
  ignored: 'neutral',
};
