import { isAbsolute, normalize, relative, sep } from 'node:path';

/** Absolute, normalised, without a trailing separator (except the filesystem root). */
export function normalizeRootPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const normalized = normalize(trimmed);
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/** Is path equal to root or inside it (segment-wise, so "/media/movies2" is not inside "/media/movies")? */
export function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

/** Longest root containing path. */
export function matchRoot<T extends { path: string }>(path: string, roots: readonly T[]): T | null {
  let best: T | null = null;
  for (const root of roots) {
    if (isWithin(path, root.path) && (best === null || root.path.length > best.path.length)) best = root;
  }
  return best;
}

export function rootsOverlap(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

export function relativeToRoot(path: string, root: string): string {
  const rel = relative(root, path);
  return rel === '' ? '.' : rel;
}
