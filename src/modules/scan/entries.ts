import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveredEntry } from '../../contracts/probe-scan.ts';
import { classifyEntry } from './change-detection.ts';

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

function findName(entries: readonly string[], wanted: string): string | undefined {
  return entries.find((name) => name.toLowerCase() === wanted.toLowerCase());
}

/** Child names as classifyEntry expects them: the folder's entries plus "BDMV/<name>" for a BDMV subfolder. */
export async function directoryChildNames(dir: string, entries?: readonly string[]): Promise<string[]> {
  const own = entries ?? (await names(dir));
  const bdmv = findName(own, 'BDMV');
  if (!bdmv) return [...own];
  const inner = await names(join(dir, bdmv));
  return [...own, ...inner.map((name) => `BDMV/${name}`)];
}

/** Disc folder: size of BDMV/STREAM, mtime of BDMV/index.bdmv (both change when the disc content is replaced). */
async function discEntry(path: string, childNames: readonly string[]): Promise<DiscoveredEntry | null> {
  const bdmv = findName(
    childNames.filter((name) => !name.includes('/')),
    'BDMV',
  );
  if (!bdmv) return null;
  const bdmvDir = join(path, bdmv);
  const inner = await names(bdmvDir);
  const index = findName(inner, 'index.bdmv');
  if (!index) return null;
  const indexInfo = await stat(join(bdmvDir, index)).catch(() => null);
  if (!indexInfo) return null;
  const streamName = findName(inner, 'STREAM');
  let sizeBytes = 0;
  if (streamName) {
    const streamDir = join(bdmvDir, streamName);
    for (const clip of await names(streamDir)) {
      const info = await stat(join(streamDir, clip)).catch(() => null);
      if (info?.isFile()) sizeBytes += info.size;
    }
  }
  return { path, kind: 'bdmv', sizeBytes, mtimeMs: Math.trunc(indexInfo.mtimeMs) };
}

/** Stats one path: a file (media file or .iso) or a disc folder. Null when missing or not a media entry. */
export async function statEntry(path: string, childNames?: readonly string[]): Promise<DiscoveredEntry | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  if (info.isFile()) {
    const kind = classifyEntry(path, false, []);
    return kind ? { path, kind, sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs) } : null;
  }
  if (!info.isDirectory()) return null;
  const children = childNames ?? (await directoryChildNames(path));
  return classifyEntry(path, true, [...children]) === 'bdmv' ? discEntry(path, children) : null;
}
