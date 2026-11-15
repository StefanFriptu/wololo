import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LibraryService } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import { binRootFor } from './paths.ts';

export interface RecycleBinLocationDeps {
  configuredPath: string | null;
  findRootForPath: LibraryService['findRootForPath'];
  warn: (message: string, context: Record<string, unknown>) => void;
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
  return { binRoot, rootPath };
}
