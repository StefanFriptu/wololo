import type { DroppedStream } from '#lib/shared.ts';

export const DROP_REASON_LABELS: Readonly<Record<DroppedStream['reason'], string>> = {
  incompatible_replaced: 'Replaced by the converted track',
  compatible_duplicate: 'Compatible track in the same language exists',
  language_filter: 'Language not in the keep-list',
  unsupported: 'Unsupported by the profile',
};
