import { posix } from 'node:path';
import { WINDOWS_PATH } from './path-map.ts';

export interface PathMappingSuggestion {
  remotePath: string;
  localPath: string;
}

interface SuggestInput {
  remotePath: string;
  localRoots: readonly string[];
  exists: (localPath: string) => boolean;
}

function remotePrefix(remotePath: string, segments: readonly string[], count: number): string {
  if (remotePath.startsWith('\\\\')) return `\\\\${segments.slice(0, count).join('\\')}`;
  if (WINDOWS_PATH.test(remotePath)) return segments.slice(0, count).join('\\');
  return `/${segments.slice(0, count).join('/')}`;
}

/**
 * Finds the remote folder that is a local root: the root that holds the file's trailing segments. Keeping the most
 * segments wins, so "/tv/Show/S01/a.mkv" under "/data/tv" maps "/tv" -> "/data/tv", not "/tv/Show" -> "/data/tv".
 */
export function suggestPathMapping({ remotePath, localRoots, exists }: SuggestInput): PathMappingSuggestion | null {
  const segments = remotePath.split(WINDOWS_PATH.test(remotePath) ? /[\\/]+/ : /\/+/).filter(Boolean);
  for (let kept = segments.length - 1; kept >= 1; kept--) {
    const tail = segments.slice(segments.length - kept);
    for (const root of localRoots) {
      const localFile = posix.join(root, ...tail);
      if (!exists(localFile)) continue;
      return {
        remotePath: remotePrefix(remotePath, segments, segments.length - kept),
        localPath: posix.normalize(root).replace(/(.)\/+$/, '$1'),
      };
    }
  }
  return null;
}
