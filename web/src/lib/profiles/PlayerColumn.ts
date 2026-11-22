import type { PlanAction } from '#lib/shared.ts';

export interface PlayerColumn {
  profileId: number;
  name: string;
  action: PlanAction;
  failingStreams: readonly number[];
}
