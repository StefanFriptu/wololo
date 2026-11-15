import type { PlanAction } from '#lib/shared.ts';

export const PLAN_ACTION_LABELS: Readonly<Record<PlanAction, string>> = {
  skip: 'Nothing to do',
  remux: 'Remux',
  convert: 'Convert',
  blocked: 'Blocked',
};
