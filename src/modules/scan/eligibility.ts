import { extname, relative, resolve, sep } from 'node:path';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import { isWithin } from '../../core/isWithin.ts';
import type { MediaFileKind } from '../../shared/domain.ts';
import type { Settings } from '../../shared/settings.ts';
import { normalizeRootPath } from './paths.ts';

/** What the scanner indexes; the walker and media.checkPath apply the same rules. */
export interface EligibilityRules {
  /** Lower-case extensions with dot. */
  extensions: readonly string[];
  /** Globs relative to the root (settings.media.ignorePatterns). */
  ignorePatterns: readonly string[];
  /** Disc folders and .iso images are indexed. */
  discs: boolean;
  /** Only disc folders and .iso images are indexed, never plain media files (a seeding download folder). */
  discsOnly?: boolean;
  /** Absolute paths never entered (e.g. a recycle bin inside the root). */
  skipPaths?: readonly string[];
}

/** Dot-prefixed names (incl. the default ".wololo-recycle") and job temp files are never indexed. */
export function skippedName(name: string): boolean {
  return name.startsWith('.') || name.includes(TEMP_FILE_MARKER);
}

/** Pure: does a relative path match an ignore glob? Directories are matched with a trailing slash. */
export function isIgnored(relativePath: string, isDirectory: boolean, globs: readonly Bun.Glob[]): boolean {
  const candidate = isDirectory ? `${relativePath}/` : relativePath;
  return globs.some((glob) => glob.match(candidate));
}

export function isSkippedPath(path: string, skipPaths: readonly string[] | undefined): boolean {
  return skipPaths?.some((skip) => isWithin(path, skip)) ?? false;
}

export function hasMediaExtension(path: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(path).toLowerCase());
}

/** Absolute, normalised skip paths: a custom recycle bin with a trailing slash or ".." segments still matches. */
export function skipPathsFor(settings: Pick<Settings, 'recycleBin'>): string[] {
  const path = settings.recycleBin.path;
  if (!path) return [];
  const normalized = normalizeRootPath(resolve(path));
  return normalized ? [normalized] : [];
}

export function eligibilityRules(
  settings: Settings,
  library: { bdmvEnabled: boolean; discsOnly: boolean },
): EligibilityRules {
  return {
    extensions: settings.media.extensions,
    ignorePatterns: settings.media.ignorePatterns,
    discs: settings.bdmv.enabled && library.bdmvEnabled,
    discsOnly: library.discsOnly,
    skipPaths: skipPathsFor(settings),
  };
}

/** Pure: why the scanner would not index this entry of a root, or null when it would. */
export function exclusionReason(
  root: string,
  path: string,
  kind: MediaFileKind,
  rules: EligibilityRules,
): string | null {
  const rel = relative(root, path);
  if (rel.startsWith('..')) return 'outside the library root';
  const segments = rel === '' ? [] : rel.split(sep);
  const folders = kind === 'bdmv' ? segments : segments.slice(0, -1);
  if (segments.some(skippedName)) return 'hidden or temporary path';
  if (isSkippedPath(path, rules.skipPaths)) return 'inside the recycle bin';
  if (folders.some((folder) => folder.toUpperCase() === 'BDMV')) return 'inside a disc structure';
  const globs = rules.ignorePatterns.map((pattern) => new Bun.Glob(pattern));
  for (let depth = 1; depth <= folders.length; depth += 1) {
    if (isIgnored(segments.slice(0, depth).join('/'), true, globs)) return 'matches an ignore pattern';
  }
  if (kind !== 'bdmv' && isIgnored(segments.join('/'), false, globs)) return 'matches an ignore pattern';
  if (kind !== 'file' && !rules.discs) return 'disc handling is disabled';
  if (kind === 'file' && rules.discsOnly) return 'library only converts discs';
  if (kind !== 'bdmv' && !hasMediaExtension(path, new Set(rules.extensions.map((ext) => ext.toLowerCase()))))
    return 'not a media file extension';
  return null;
}
