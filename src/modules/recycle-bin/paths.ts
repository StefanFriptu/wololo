import { basename, dirname, join, relative, sep } from 'node:path';
import { RECYCLE_DIR_NAME } from '../../core/recyclePaths.ts';
import { DAY_MS } from '../../core/time.ts';

/** Compact UTC stamp used as the per-recycle folder name: "20261115T103000Z". */
export function recycleStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Configured bin, else "<library root>/.wololo-recycle", else a bin next to the file (always the same filesystem). */
export function binRootFor(options: { configuredPath: string | null; rootPath: string | null; path: string }): string {
  if (options.configuredPath) return options.configuredPath;
  return join(options.rootPath ?? dirname(options.path), RECYCLE_DIR_NAME);
}

/**
 * "<bin>/<stamp>[-n]/<path relative to the library root>" keeps the folder context for restores and lets two files with
 * the same name share a stamp. attempt > 0 adds a suffix for collisions.
 */
export function recyclePathFor(options: {
  binRoot: string;
  rootPath: string | null;
  originalPath: string;
  stamp: string;
  attempt?: number;
}): string {
  const { binRoot, rootPath, originalPath, stamp, attempt = 0 } = options;
  const insideRoot =
    rootPath !== null && originalPath.startsWith(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`);
  const rel = insideRoot ? relative(rootPath, originalPath) : basename(originalPath);
  return join(binRoot, attempt > 0 ? `${stamp}-${attempt}` : stamp, rel);
}

export function expiresAtFor(createdAt: Date, retentionDays: number): string {
  return new Date(createdAt.getTime() + retentionDays * DAY_MS).toISOString();
}
