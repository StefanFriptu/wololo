import type { SetupStep } from '#lib/shared.ts';

export type SetupCheckState = 'ok' | 'warn' | 'bad' | 'running';

/** One row of a setup checklist; fixStep is where the Fix button leads. */
export interface SetupCheck {
  key: string;
  state: SetupCheckState;
  title: string;
  detail?: string | null;
  fixStep?: SetupStep | null;
}
