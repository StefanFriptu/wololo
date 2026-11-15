import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import type { DiscoveredEntry } from '../../contracts/probe-scan.ts';
import { classifyEntry } from './change-detection.ts';
import { directoryChildNames, statEntry } from './entries.ts';
import { isWithin } from './paths.ts';

export interface WalkOptions {
  /** Lower-case extensions with dot. */
  extensions: readonly string[];
  /** Globs relative to the root (settings.media.ignorePatterns). */
  ignorePatterns: readonly string[];
  /** Disc folders and .iso images are reported (false: skipped entirely). */
  discs: boolean;
  /** Absolute paths never entered (e.g. a recycle bin inside the root). */
  skipPaths?: readonly string[];
  signal?: AbortSignal;
}

export interface WalkReport {
  /** Directories that could not be read; rows below them must not be treated as removed. */
  unreadable: string[];
}

/** Pure: does a relative path match an ignore glob? Directories are matched with a trailing slash. */
export function isIgnored(relativePath: string, isDirectory: boolean, globs: readonly Bun.Glob[]): boolean {
  const candidate = isDirectory ? `${relativePath}/` : relativePath;
  return globs.some((glob) => glob.match(candidate));
}

function skippedName(name: string): boolean {
  return name.startsWith('.') || name.includes(TEMP_FILE_MARKER);
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
        const skipped = options.skipPaths?.some((path) => isWithin(full, path)) ?? false;
        if (!isOrphanBdmv && !skipped) subdirs.push(full);
        continue;
      }
      const ext = extname(dirent.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      if (ext === '.iso' && !options.discs) continue;
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
