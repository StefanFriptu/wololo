import { statfsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

/** Bytes available to unprivileged users on path's filesystem; rejects when statfs fails. */
export async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Synchronous freeBytes; throws when statfs fails. */
export function freeBytesSync(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}
