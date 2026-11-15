import { chmodSync, chownSync, renameSync, type Stats, statSync, unlinkSync } from 'node:fs';
import { errorMessage } from '../../core/errors.ts';

/** The filesystem calls of the swap; tests swap single calls to simulate a crash at an exact point. */
export interface ReplaceFs {
  stat(path: string): Stats;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export const NODE_REPLACE_FS: ReplaceFs = {
  stat: (path) => statSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
  chown: (path, uid, gid) => chownSync(path, uid, gid),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
};

/** Gives target the permission bits and owner of source; a refused chown (not root, NFS/CIFS) is reported, not fatal. */
export function copyOwnership(fs: ReplaceFs, source: Stats, target: string): string | null {
  fs.chmod(target, source.mode & 0o7777);
  const current = fs.stat(target);
  if (current.uid === source.uid && current.gid === source.gid) return null;
  try {
    fs.chown(target, source.uid, source.gid);
    return null;
  } catch (error) {
    return `could not keep owner ${source.uid}:${source.gid} (${errorMessage(error)})`;
  }
}

export interface ReplaceInput {
  sourcePath: string;
  tempPath: string;
  outputPath: string;
  /** Recycle-bin step 2 of the contract; null when the bin is disabled. */
  recycle: (() => Promise<{ entryId: number; mode: 'link' | 'move' }>) | null;
  fs: ReplaceFs;
  warn: (message: string) => void;
}

/**
 * Steps 2-3 of the replace sequence in contracts/jobs.ts. The caller has already persisted step "replacing" and the
 * temp path. Ownership is copied before the original can disappear; the rename is the atomic swap.
 */
export async function replaceOriginal(input: ReplaceInput): Promise<{ recycleBinEntryId: number | null }> {
  const { fs } = input;
  const sourceStats = fs.stat(input.sourcePath);
  const ownershipWarning = copyOwnership(fs, sourceStats, input.tempPath);
  if (ownershipWarning) input.warn(ownershipWarning);
  const recycled = input.recycle ? await input.recycle() : null;
  fs.rename(input.tempPath, input.outputPath);
  if (input.outputPath !== input.sourcePath && recycled?.mode !== 'move') fs.unlink(input.sourcePath);
  return { recycleBinEntryId: recycled?.entryId ?? null };
}
