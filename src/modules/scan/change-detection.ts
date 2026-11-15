import { basename, extname } from 'node:path';
import type { ClassifyEntry, NeedsRecheck } from '../../contracts/probe-scan.ts';

export const needsRecheck: NeedsRecheck = (entry, stored, currentRulesKey, force) => {
  if (stored === null) return true;
  if (stored.status === 'ignored' || stored.status === 'processing') return force;
  if (force || stored.status === 'pending') return true;
  if (stored.sizeBytes !== entry.sizeBytes) return true;
  if (Math.trunc(stored.mtimeMs) !== Math.trunc(entry.mtimeMs)) return true;
  return stored.rulesKey !== currentRulesKey;
};

/**
 * Directories: childNames are the folder's entries, plus "BDMV/<name>" for the entries of a BDMV subfolder, so a disc
 * root is recognised by "BDMV/index.bdmv". Files: ".iso" is a disc image, anything else a media file (the scanner
 * filters extensions before classifying).
 */
export const classifyEntry: ClassifyEntry = (path, isDirectory, childNames) => {
  if (!isDirectory) return extname(path).toLowerCase() === '.iso' ? 'iso' : 'file';
  if (basename(path).toUpperCase() === 'BDMV') return null;
  return childNames.some((name) => name.toLowerCase() === 'bdmv/index.bdmv') ? 'bdmv' : null;
};
