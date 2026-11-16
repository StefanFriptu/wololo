import { randomUUID } from 'node:crypto';
import { accessSync, constants, linkSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import { isLinkUnsupported } from '../jobs/isLinkUnsupported.ts';
import { binRootFor } from './paths.ts';

/** The calls of the trial run; remove must not fail on a missing path. */
export interface BinTrialFs {
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  writeFile(path: string): void;
  remove(path: string): void;
}

export const NODE_BIN_TRIAL_FS: BinTrialFs = {
  link: (from, to) => linkSync(from, to),
  rename: (from, to) => renameSync(from, to),
  writeFile: (path) => writeFileSync(path, ''),
  remove: (path) => rmSync(path, { force: true }),
};

export interface RecycleBinLocationDeps {
  configuredPath: string | null;
  findRootForPath: LibraryService['findRootForPath'];
  warn: (message: string, context: Record<string, unknown>) => void;
  /** Set for the preflight: proves with real calls that the replace step can link (or, without hard links, move). */
  trialFs?: BinTrialFs;
}

function trialMove(fs: BinTrialFs, binRoot: string, path: string, name: string): void {
  const inBin = join(binRoot, name);
  const inLibrary = join(dirname(path), name);
  try {
    fs.writeFile(inBin);
    fs.rename(inBin, inLibrary);
    fs.rename(inLibrary, inBin);
  } finally {
    fs.remove(inBin);
    fs.remove(inLibrary);
  }
}

/** Two bind mounts of one disk share st_dev but refuse link() and rename() between them (EXDEV). */
function trialShare(fs: BinTrialFs, binRoot: string, path: string): void {
  const name = `.wololo-probe-${process.pid}-${randomUUID().slice(0, 8)}`;
  const probe = join(binRoot, name);
  try {
    fs.link(path, probe);
    return;
  } catch (error) {
    if (!isLinkUnsupported(error)) throw error;
  } finally {
    fs.remove(probe);
  }
  trialMove(fs, binRoot, path, name);
}

/**
 * Resolves the bin that would take path, creates it and makes sure it is writable and on the same filesystem as path.
 * Throws AppError('precondition_failed') otherwise, so a job can fail before it spends time encoding.
 */
export async function checkRecycleBinLocation(
  deps: RecycleBinLocationDeps,
  path: string,
): Promise<{ binRoot: string; rootPath: string | null }> {
  let rootPath: string | null = null;
  try {
    rootPath = (await deps.findRootForPath(path))?.rootPath ?? null;
  } catch (error) {
    deps.warn('cannot resolve the library root, using a bin next to the file', { path, error: errorMessage(error) });
  }
  const binRoot = binRootFor({ configuredPath: deps.configuredPath, rootPath, path });
  try {
    mkdirSync(binRoot, { recursive: true });
    accessSync(binRoot, constants.W_OK);
  } catch (error) {
    throw new AppError('precondition_failed', `recycle bin ${binRoot} is not writable: ${errorMessage(error)}`);
  }
  if (statSync(binRoot).dev !== statSync(dirname(path)).dev)
    throw new AppError('precondition_failed', `recycle bin ${binRoot} is on another filesystem than ${path}`);
  if (deps.trialFs) {
    try {
      trialShare(deps.trialFs, binRoot, path);
    } catch (error) {
      throw new AppError(
        'precondition_failed',
        `recycle bin ${binRoot} cannot share files with ${path}: ${errorMessage(error)}`,
      );
    }
  }
  return { binRoot, rootPath };
}
