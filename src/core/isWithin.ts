import { sep } from 'node:path';

/** Is path equal to folder or inside it (segment-wise, so "/media/movies2" is not inside "/media/movies")? */
export function isWithin(path: string, folder: string): boolean {
  const base = folder.length > 1 && folder.endsWith(sep) ? folder.slice(0, -1) : folder;
  if (path === base) return true;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return path.startsWith(prefix);
}
