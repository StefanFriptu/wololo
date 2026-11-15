import { basename, dirname, join, relative, sep } from 'node:path';

export const RECYCLE_DIR_NAME = '.wololo-recycle';
const STAMP_PATTERN = /^\d{8}T\d{6}Z(-\d+)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Compact UTC stamp used as the per-recycle folder name: "20261115T103000Z". */
export function recycleStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function isRecycleStamp(name: string): boolean {
  return STAMP_PATTERN.test(name);
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
