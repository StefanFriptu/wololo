import { isActiveJobState, type JobState } from '#lib/shared.ts';

/** DELETE /api/v1/jobs/:id answers 409 for queued and running jobs: those must be cancelled first. */
export function isRemovable(state: JobState): boolean {
  return !isActiveJobState(state);
}
