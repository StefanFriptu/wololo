import type { JobState } from '#lib/shared.ts';
import type { Tone } from './Tone.ts';

export const JOB_STATE_TONES: Readonly<Record<JobState, Tone>> = {
  queued: 'neutral',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};
