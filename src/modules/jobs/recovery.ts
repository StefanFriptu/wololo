import type { JobStep, JobType } from '../../shared/domain.ts';

/**
 * keep_original: the swap never happened; drop the bin link, delete the temp file, re-queue.
 * finish_rename: the original went to the bin by rename (no hard links); move the verified temp file into place.
 * fail_source_missing: the original is gone and not in the bin (deleted or renamed by someone else); drop the temp file.
 * complete: the swap happened. complete_remove_source: same, plus the old non-mkv source is still next to the output.
 * complete_drop_temp: the temp file was hard-linked to the new output path but not yet unlinked.
 * restore_from_bin: the original is only in the bin; put it back, delete the temp file and re-queue.
 */
export type RecoveryAction =
  | 'keep_original'
  | 'finish_rename'
  | 'complete'
  | 'complete_remove_source'
  | 'complete_drop_temp'
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
  /** Temp file and a new output path are the same inode. */
  tempIsOutput: boolean;
  hasBinEntry: boolean;
}

function decideReplacing(input: RecoveryInput): RecoveryAction {
  if (input.tempIsOutput) return 'complete_drop_temp';
  if (input.tempExists && input.sourceExists) return 'keep_original';
  if (input.tempExists && input.hasBinEntry && (input.samePath || !input.outputExists)) return 'finish_rename';
  if (input.tempExists) return input.hasBinEntry ? 'restore_from_bin' : 'fail_source_missing';
  if (input.outputExists) return !input.samePath && input.sourceExists ? 'complete_remove_source' : 'complete';
  if (input.sourceExists) return 'keep_original';
  return input.hasBinEntry ? 'restore_from_bin' : 'fail_source_missing';
}

export function decideRecovery(input: RecoveryInput): RecoveryAction {
  if (input.type !== 'audio') return 'requeue';
  if (input.step === 'replacing') return decideReplacing(input);
  if (input.step === 'notifying' && input.outputExists) return 'complete';
  return 'requeue';
}
