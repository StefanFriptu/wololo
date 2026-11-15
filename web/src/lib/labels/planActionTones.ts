import type { PlanAction } from '#lib/shared.ts';
import type { Tone } from './Tone.ts';

export const PLAN_ACTION_TONES: Readonly<Record<PlanAction, Tone>> = {
  skip: 'success',
  remux: 'info',
  convert: 'warning',
  blocked: 'danger',
};
