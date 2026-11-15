import type { JobStep, JobType } from '../../shared/domain.ts';

/**
 * keep_original: the swap never happened; drop the bin link, delete the temp file, re-queue.
 * finish_rename: the original went to the bin by rename (no hard links); move the verified temp file into place.
 * complete: the swap happened. complete_remove_source: same, plus the old non-mkv source is still next to the output.
 * restore_from_bin: neither file is in the library; put the original back from the bin and re-queue.
 * requeue: interrupted before the replace step; delete the temp path and re-queue.
 */
export type RecoveryAction =
  | 'keep_original'
  | 'finish_rename'
  | 'complete'
  | 'complete_remove_source'
  | 'restore_from_bin'
  | 'fail_source_missing'
  | 'requeue';

export interface RecoveryInput {
  type: JobType;
  step: JobStep;
  tempExists: boolean;
  sourceExists: boolean;
  /** Final path (outputPathFor(source)); equals sourceExists when the output replaces the source in place. */
  outputExists: boolean;
  samePath: boolean;
  hasBinEntry: boolean;
}

export function decideRecovery(input: RecoveryInput): RecoveryAction {
  if (input.type !== 'audio' || input.step !== 'replacing') return 'requeue';
  if (input.tempExists) return input.sourceExists ? 'keep_original' : 'finish_rename';
  if (input.outputExists) return !input.samePath && input.sourceExists ? 'complete_remove_source' : 'complete';
  if (input.sourceExists) return 'keep_original';
  return input.hasBinEntry ? 'restore_from_bin' : 'fail_source_missing';
}
