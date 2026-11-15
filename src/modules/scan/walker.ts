import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { DiscoveredEntry } from '../../contracts/probe-scan.ts';
import { classifyEntry } from './change-detection.ts';
import { type EligibilityRules, hasMediaExtension, isIgnored, isSkippedPath, skippedName } from './eligibility.ts';
import { directoryChildNames, statEntry } from './entries.ts';

export interface WalkOptions extends EligibilityRules {
  signal?: AbortSignal;
}

export interface WalkReport {
  /** Directories that could not be read; rows below them must not be treated as removed. */
  unreadable: string[];
}

async function resolveType(dir: string, dirent: Dirent): Promise<'file' | 'dir' | null> {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (!dirent.isSymbolicLink()) return null;
  const target = await stat(join(dir, dirent.name)).catch(() => null);
  return target?.isFile() ? 'file' : null;
}

/**
 * Depth-first walk of one library root yielding media files, .iso images and disc folders (never descending into a
 * disc). Symlinked directories are not followed (loops); symlinked files are.
 */
export async function* walkRoot(
  root: string,
  options: WalkOptions,
  report: WalkReport,
): AsyncGenerator<DiscoveredEntry> {
  const globs = options.ignorePatterns.map((pattern) => new Bun.Glob(pattern));
  const extensions = new Set(options.extensions.map((ext) => ext.toLowerCase()));
  const stack = [root];
  while (stack.length > 0) {
    if (options.signal?.aborted) return;
    const dir = stack.pop() as string;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      report.unreadable.push(dir);
      continue;
    }
    const children = await directoryChildNames(
      dir,
      dirents.map((dirent) => dirent.name),
    );
    if (classifyEntry(dir, true, children) === 'bdmv') {
      if (!options.discs) continue;
      const disc = await statEntry(dir, children);
      if (disc) yield disc;
      continue;
    }

    const subdirs: string[] = [];
    const files: string[] = [];
    for (const dirent of dirents) {
      if (skippedName(dirent.name)) continue;
      const full = join(dir, dirent.name);
      const type = await resolveType(dir, dirent);
      if (type === null) continue;
      if (isIgnored(relative(root, full), type === 'dir', globs)) continue;
      if (type === 'dir') {
        const isOrphanBdmv = dirent.name.toUpperCase() === 'BDMV';
        if (!isOrphanBdmv && !isSkippedPath(full, options.skipPaths)) subdirs.push(full);
        continue;
      }
      if (!hasMediaExtension(dirent.name, extensions)) continue;
      if (extname(dirent.name).toLowerCase() === '.iso' && !options.discs) continue;
      files.push(full);
    }

    files.sort();
    for (const file of files) {
      if (options.signal?.aborted) return;
      const entry = await statEntry(file);
      if (entry) yield entry;
    }
    subdirs.sort().reverse();
    stack.push(...subdirs);
  }
}
