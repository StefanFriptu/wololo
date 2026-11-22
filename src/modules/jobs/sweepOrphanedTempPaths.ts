import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RECYCLE_DIR_NAME } from '../../core/recyclePaths.ts';
import { isTempPath } from './paths.ts';

export interface SweepOptions {
  roots: string[];
  /** false checks only the roots' own entries, where BDMV jobs put their temp directories. */
  recursive: boolean;
  isReferenced: (path: string) => boolean;
  onError: (path: string, error: unknown) => void;
}

/** Deletes "*.wololo-tmp*" files and directories under roots that no job row references. Returns how many. */
export async function sweepOrphanedTempPaths(options: SweepOptions): Promise<number> {
  let deleted = 0;
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onError(dir, error);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (isTempPath(path)) {
        if (options.isReferenced(path)) continue;
        try {
          await rm(path, { recursive: true, force: true });
          deleted += 1;
        } catch (error) {
          options.onError(path, error);
        }
        continue;
      }
      if (options.recursive && entry.isDirectory() && entry.name !== RECYCLE_DIR_NAME) await visit(path);
    }
  };
  for (const root of options.roots) await visit(root);
  return deleted;
}
