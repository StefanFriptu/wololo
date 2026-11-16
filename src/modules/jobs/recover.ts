import { existsSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import type { Db } from '../../db/client.ts';
import type { JobRow } from '../../db/schema.ts';
import { removeEmptyRecycleDirs } from '../recycle-bin/cleanup.ts';
import { deleteRecycleRow, getRecycleRow, markRecycleRow } from '../recycle-bin/recycleBinQueries.ts';
import { isTempPath, outputPathFor } from './paths.ts';
import { decideRecovery, type RecoveryAction } from './recovery.ts';

export type ReplaceResolution =
  | { kind: 'completed'; outputPath: string; action: RecoveryAction }
  | { kind: 'requeue'; action: RecoveryAction; tempDeleted: boolean }
  | { kind: 'source_missing'; action: RecoveryAction; tempDeleted: boolean };

function sameInode(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

export function deleteTempPath(path: string | null): boolean {
  if (!path || !isTempPath(path) || !existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Applies decideRecovery to a job that stopped while running (crash, or a failure inside the replace step). Only file
 * and recycle-bin effects happen here; the caller moves the job row to its next state.
 */
export function resolveInterruptedJob(
  db: Db,
  row: JobRow,
  options: { notes: (line: string) => void; now: Date },
): ReplaceResolution {
  const { notes } = options;
  const sourcePath = row.sourcePath;
  const outputPath = outputPathFor(sourcePath);
  const samePath = outputPath === sourcePath;
  const tempPath = row.tempPath;
  const tempExists = tempPath !== null && existsSync(tempPath);
  const binRow = row.recycleBinEntryId === null ? undefined : getRecycleRow(db, row.recycleBinEntryId);
  const binActive = binRow !== undefined && binRow.restoredAt === null && binRow.purgedAt === null;
  const action = decideRecovery({
    type: row.type,
    step: row.step,
    tempExists,
    sourceExists: existsSync(sourcePath),
    outputExists: existsSync(outputPath),
    samePath,
    tempIsOutput: tempExists && !samePath && tempPath !== null && sameInode(tempPath, outputPath),
    hasBinEntry: binActive && existsSync(binRow.recyclePath),
  });
  notes(`recovery of job ${row.id} (step ${row.step}): ${action}`);

  switch (action) {
    case 'requeue':
      return { kind: 'requeue', action, tempDeleted: deleteTempPath(tempPath) };
    case 'keep_original': {
      if (binRow && binActive) {
        if (!existsSync(binRow.recyclePath)) {
          deleteRecycleRow(db, binRow.id);
          notes(`dropped recycle-bin entry ${binRow.id}: the original never reached ${binRow.recyclePath}`);
        } else if (sameInode(binRow.recyclePath, sourcePath)) {
          unlinkSync(binRow.recyclePath);
          removeEmptyRecycleDirs(binRow.recyclePath);
          deleteRecycleRow(db, binRow.id);
          notes(`dropped recycle-bin link ${binRow.recyclePath}`);
        } else {
          notes(`kept recycle-bin entry ${binRow.recyclePath}: it is not a link of the original`);
        }
      }
      return { kind: 'requeue', action, tempDeleted: deleteTempPath(tempPath) };
    }
    case 'finish_rename':
      if (!tempPath) return { kind: 'source_missing', action, tempDeleted: false };
      renameSync(tempPath, outputPath);
      notes(`moved verified ${tempPath} to ${outputPath}`);
      return { kind: 'completed', outputPath, action };
    case 'complete':
      return { kind: 'completed', outputPath, action };
    case 'complete_remove_source':
      unlinkSync(sourcePath);
      notes(`removed old source ${sourcePath}`);
      return { kind: 'completed', outputPath, action };
    case 'complete_drop_temp':
      if (tempPath) unlinkSync(tempPath);
      if (existsSync(sourcePath)) unlinkSync(sourcePath);
      notes(`dropped ${tempPath} and the old source, ${outputPath} is in place`);
      return { kind: 'completed', outputPath, action };
    case 'restore_from_bin': {
      if (!binRow) return { kind: 'source_missing', action, tempDeleted: false };
      renameSync(binRow.recyclePath, sourcePath);
      markRecycleRow(db, binRow.id, { restoredAt: options.now.toISOString() });
      notes(`restored ${sourcePath} from the recycle bin`);
      return { kind: 'requeue', action, tempDeleted: deleteTempPath(tempPath) };
    }
    case 'fail_source_missing':
      return { kind: 'source_missing', action, tempDeleted: deleteTempPath(tempPath) };
  }
}
