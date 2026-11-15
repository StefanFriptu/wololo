import { readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isRecycleStamp, RECYCLE_DIR_NAME } from './paths.ts';

/** Removes now-empty folders between a recycled file and its stamp folder (inclusive); never climbs above the stamp. */
export function removeEmptyRecycleDirs(recyclePath: string): void {
  let dir = dirname(recyclePath);
  for (let depth = 0; depth < 64; depth++) {
    const name = basename(dir);
    if (name === RECYCLE_DIR_NAME || dir === dirname(dir)) return;
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    if (isRecycleStamp(name)) return;
    dir = dirname(dir);
  }
}
