import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { AppError, errorMessage } from '../../core/errors.ts';
import { isLinkUnsupported } from './isLinkUnsupported.ts';

/** The filesystem calls of the swap; tests swap single calls to simulate a crash at an exact point. */
export interface ReplaceFs {
  stat(path: string): Stats;
  exists(path: string): boolean;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  fsync(path: string): void;
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const NODE_REPLACE_FS: ReplaceFs = {
  stat: (path) => statSync(path),
  exists: (path) => existsSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
  chown: (path, uid, gid) => chownSync(path, uid, gid),
  fsync: fsyncPath,
  link: (from, to) => linkSync(from, to),
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

function outputAppeared(outputPath: string): AppError {
  return new AppError('conflict', `output path appeared during the job, not overwriting it: ${outputPath}`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/** Moves temp to a new output path without ever replacing a file that is already there. */
function moveWithoutClobber(fs: ReplaceFs, tempPath: string, outputPath: string): void {
  try {
    fs.link(tempPath, outputPath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw outputAppeared(outputPath);
    if (!isLinkUnsupported(error)) throw error;
    if (fs.exists(outputPath)) throw outputAppeared(outputPath);
    fs.rename(tempPath, outputPath);
    return;
  }
  fs.unlink(tempPath);
}

/** What identifies the source as the file that was probed and planned; ctime is left out, the bin hard link bumps it. */
export type SourceIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;

function sameSource(current: Stats, expected: SourceIdentity): boolean {
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs
  );
}

export interface ReplaceInput {
  sourcePath: string;
  /** The source as it was stat'ed before probing; a different file there now is never replaced. */
  expectedSource: SourceIdentity;
  tempPath: string;
  outputPath: string;
  /** Recycle-bin step 2 of the contract; null when the bin is disabled. */
  recycle: (() => Promise<{ entryId: number; mode: 'link' | 'move' }>) | null;
  fs: ReplaceFs;
  warn: (message: string) => void;
}

/**
 * Steps 2-3 of the replace sequence in contracts/jobs.ts. The caller has already persisted step "replacing" and the
 * temp path. The temp file is flushed to disk and given the original's owner before the original can disappear. In
 * place, rename is the atomic swap; a new output path (mp4 -> mkv) is created by link + unlink so a file that appeared
 * there meanwhile is never overwritten.
 */
export async function replaceOriginal(input: ReplaceInput): Promise<{ recycleBinEntryId: number | null }> {
  const { fs, sourcePath, tempPath, outputPath } = input;
  const inPlace = outputPath === sourcePath;
  const sourceStats = fs.stat(sourcePath);
  if (!sameSource(sourceStats, input.expectedSource))
    throw new AppError('conflict', `source changed during the job, not replacing it: ${sourcePath}`);
  const ownershipWarning = copyOwnership(fs, sourceStats, tempPath);
  if (ownershipWarning) input.warn(ownershipWarning);
  fs.fsync(tempPath);
  if (!inPlace && fs.exists(outputPath)) throw outputAppeared(outputPath);
  const recycled = input.recycle ? await input.recycle() : null;
  if (inPlace) fs.rename(tempPath, outputPath);
  else moveWithoutClobber(fs, tempPath, outputPath);
  try {
    fs.fsync(dirname(outputPath));
  } catch (error) {
    input.warn(`could not flush ${dirname(outputPath)} (${errorMessage(error)})`);
  }
  if (!inPlace && recycled?.mode !== 'move') fs.unlink(sourcePath);
  return { recycleBinEntryId: recycled?.entryId ?? null };
}
