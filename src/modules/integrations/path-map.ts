import type { MapPath } from '../../contracts/integrations.ts';

export const WINDOWS_PATH = /^[a-zA-Z]:[\\/]|^\\\\/;

function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path) || (path.includes('\\') && !path.includes('/'));
}

function separatorOf(path: string): '/' | '\\' {
  return isWindowsPath(path) ? '\\' : '/';
}

/** Strips trailing separators, keeping a bare root ("/", "C:\"). */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed === '') return path.length > 0 ? path.slice(0, 1) : path;
  if (/^[a-zA-Z]:$/.test(trimmed)) return `${trimmed}${separatorOf(path)}`;
  return trimmed;
}

function prefixRemainder(path: string, prefix: string): string | null {
  const windows = isWindowsPath(prefix);
  const subject = windows ? path.toLowerCase().replaceAll('/', '\\') : path;
  const base = windows ? prefix.toLowerCase().replaceAll('/', '\\') : prefix;
  if (subject === base) return '';
  const withSeparator = /[\\/]$/.test(base) ? base : `${base}${windows ? '\\' : '/'}`;
  if (!subject.startsWith(withSeparator)) return null;
  return path.slice(withSeparator.length);
}

/** A remainder below a POSIX prefix keeps backslashes: they are legal in Linux file names, not separators. */
function joinMapped(to: string, remainder: string, sourceIsWindows: boolean): string {
  if (remainder === '') return to;
  const separator = separatorOf(to);
  const segments = remainder
    .split(sourceIsWindows ? /[\\/]+/ : /\/+/)
    .filter(Boolean)
    .join(separator);
  return /[\\/]$/.test(to) ? `${to}${segments}` : `${to}${separator}${segments}`;
}

/** Longest `from` prefix on a segment boundary wins; Windows-style prefixes match case-insensitively. */
export const mapPath: MapPath = (path, mappings) => {
  let best: { from: string; to: string; remainder: string } | null = null;
  for (const mapping of mappings) {
    const from = trimTrailingSeparators(mapping.from);
    if (from === '') continue;
    const remainder = prefixRemainder(path, from);
    if (remainder == null) continue;
    if (best && best.from.length >= from.length) continue;
    best = { from, to: trimTrailingSeparators(mapping.to), remainder };
  }
  if (!best) return path;
  return joinMapped(best.to, best.remainder, isWindowsPath(best.from));
};

/** Joins a relative path onto a folder in the folder's own separator style (remote apps may run on Windows). */
export function joinRemotePath(folder: string, relative: string): string {
  const base = trimTrailingSeparators(folder);
  return joinMapped(base, relative, isWindowsPath(base));
}

/** True when `path` equals `parent` or lies below it (segment boundary, no partial names). */
export function isSameOrInside(path: string, parent: string): boolean {
  return prefixRemainder(path, trimTrailingSeparators(parent)) != null;
}

/** True when any segment is "..", which would let a path from an upstream payload climb out of its folder. */
export function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..');
}
