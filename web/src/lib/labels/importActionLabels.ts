import type { ImportAction } from '#lib/shared.ts';

export const IMPORT_ACTION_LABELS: Readonly<Record<ImportAction, string>> = {
  check_only: 'Check only',
  convert_strictest: 'Always convert for the strictest profile',
  convert_for_profile: 'Always convert for',
};
