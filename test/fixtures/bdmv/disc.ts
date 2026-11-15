/** Writes a synthetic BDMV folder (index, playlists, clip infos, tiny stream files) for service tests. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ClpiSpec, type MplsSpec, writeClpi, writeMpls } from './writers.ts';

export interface DiscFolderSpec {
  playlists: Record<string, MplsSpec>;
  clips?: Record<string, ClpiSpec & { streamBytes?: number }>;
  /** Extra files relative to the disc root, e.g. "AACS/Unit_Key_RO.inf". */
  files?: Record<string, string | Uint8Array>;
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function writeDiscFolder(root: string, spec: DiscFolderSpec): string {
  write(join(root, 'BDMV', 'index.bdmv'), 'INDX0200');
  write(join(root, 'BDMV', 'MovieObject.bdmv'), 'MOBJ0200');
  for (const [name, playlist] of Object.entries(spec.playlists))
    write(join(root, 'BDMV', 'PLAYLIST', name), writeMpls(playlist));
  const clipIds = new Set(Object.values(spec.playlists).flatMap((p) => p.playItems.map((item) => item.clipId)));
  for (const clipId of clipIds) {
    const clip = spec.clips?.[clipId] ?? {};
    write(join(root, 'BDMV', 'CLIPINF', `${clipId}.clpi`), writeClpi(clip));
    write(join(root, 'BDMV', 'STREAM', `${clipId}.m2ts`), new Uint8Array(clip.streamBytes ?? 192));
  }
  for (const [path, content] of Object.entries(spec.files ?? {})) write(join(root, path), content);
  return root;
}
