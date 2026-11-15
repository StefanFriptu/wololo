import type { BdmvDecisionKind } from '#lib/shared.ts';

export const DECISION_KIND_LABELS: Readonly<Record<BdmvDecisionKind, string>> = {
  main_title: 'Main title',
  movie_match: 'Movie match',
  delete_source: 'Delete source',
};
