import { basename, dirname, isAbsolute, resolve } from 'node:path';

export const RECYCLE_DIR_NAME = '.wololo-recycle';
const STAMP_PATTERN = /^\d{8}T\d{6}Z(-\d+)?$/;

export function isRecycleStamp(name: string): boolean {
  return STAMP_PATTERN.test(name);
}

export function isNormalizedAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

/** Shape check for paths read back from the database: "<bin>/<stamp>[-n]/<rel>", absolute and normalized. */
export function isRecyclePath(path: string): boolean {
  if (!isNormalizedAbsolutePath(path)) return false;
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    if (isRecycleStamp(basename(dir))) return true;
  }
  return false;
}
