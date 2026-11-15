import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MainTitlePick, MplsPlaylist } from '../../contracts/bdmv.ts';
import { errorMessage } from '../../core/errors.ts';
import { type DiscEntry, findEntry, type SevenZipIsoReader } from './iso.ts';
import { parseClpi, parseMpls, withClipLanguages } from './mpls.ts';
import { dedupePlaylists, detectEncryption, pickMainTitle } from './titles.ts';

export type DiscKind = 'bdmv' | 'iso';

export interface DiscSource {
  kind: DiscKind;
  /** Disc root folder (the one containing BDMV/) or the .iso file. */
  path: string;
  entries: DiscEntry[];
  readFiles(paths: readonly string[]): Promise<Map<string, Uint8Array>>;
}

const MAX_FOLDER_DEPTH = 6;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}

async function hasIndex(bdmvDir: string): Promise<boolean> {
  return (await listDir(bdmvDir)).some((entry) => entry.isFile() && entry.name.toLowerCase() === 'index.bdmv');
}

/** A folder holding BDMV/index.bdmv, the BDMV folder itself, or an .iso that isBlurayIso confirms. */
export async function detectDisc(
  path: string,
  isBlurayIso: (isoPath: string) => Promise<boolean>,
): Promise<{ kind: DiscKind; discRoot: string } | null> {
  const info = await stat(path).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!info) return null;
  if (info.isFile()) return /\.iso$/i.test(path) && (await isBlurayIso(path)) ? { kind: 'iso', discRoot: path } : null;
  if (!info.isDirectory()) return null;
  if (basename(path).toLowerCase() === 'bdmv' && (await hasIndex(path)))
    return { kind: 'bdmv', discRoot: dirname(path) };
  for (const entry of await listDir(path)) {
    if (entry.isDirectory() && entry.name.toLowerCase() === 'bdmv' && (await hasIndex(join(path, entry.name))))
      return { kind: 'bdmv', discRoot: path };
  }
  return null;
}

async function walkFolder(root: string, relative = '', depth = 0): Promise<DiscEntry[]> {
  const entries: DiscEntry[] = [];
  for (const entry of await listDir(join(root, relative))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push({ path, sizeBytes: 0, directory: true });
      if (depth < MAX_FOLDER_DEPTH) entries.push(...(await walkFolder(root, path, depth + 1)));
    } else if (entry.isFile()) {
      entries.push({ path, sizeBytes: (await stat(join(root, path))).size, directory: false });
    }
  }
  return entries;
}

export async function openDisc(path: string, kind: DiscKind, isoReader: SevenZipIsoReader): Promise<DiscSource> {
  if (kind === 'iso') {
    return {
      kind,
      path,
      entries: await isoReader.entries(path),
      readFiles: (paths) => isoReader.readFiles(path, paths),
    };
  }
  const entries = await walkFolder(path);
  return {
    kind,
    path,
    entries,
    readFiles: async (paths) => {
      const files = new Map<string, Uint8Array>();
      for (const wanted of paths) {
        const entry = findEntry(entries, wanted);
        if (entry && !entry.directory) files.set(wanted, new Uint8Array(await readFile(join(path, entry.path))));
      }
      return files;
    },
  };
}

/** Pure: the disc title from BDMV/META/DL/bdmt_<lang>.xml (<di:name>). */
export function parseDiscTitle(xml: string): string | null {
  const match = /<di:name>\s*([^<]*?)\s*<\/di:name>/.exec(xml);
  return match?.[1] ? match[1] : null;
}

export interface DiscAnalysis {
  source: DiscSource;
  encryption: { encrypted: boolean; markers: string[] };
  /** Every parsed playlist, by name. */
  playlists: MplsPlaylist[];
  /** "<playlist>: <error>" for every MPLS that could not be parsed. */
  parseErrors: string[];
  /** Non-fatal problems, e.g. a CLPI that could not be parsed for language fallback. */
  warnings: string[];
  duplicateOf: Record<string, string>;
  pick: MainTitlePick;
  volumeLabel: string | null;
}

const PLAYLIST_PATH = /^BDMV\/PLAYLIST\/(\d{5}\.mpls)$/i;
const META_PATH = /^BDMV\/META\/DL\/bdmt_(\w+)\.xml$/i;

async function readPlaylists(source: DiscSource): Promise<{ playlists: MplsPlaylist[]; errors: string[] }> {
  const paths = source.entries.filter((entry) => !entry.directory && PLAYLIST_PATH.test(entry.path));
  const files = await source.readFiles(paths.map((entry) => entry.path));
  const playlists: MplsPlaylist[] = [];
  const errors: string[] = [];
  for (const entry of paths) {
    const name = PLAYLIST_PATH.exec(entry.path)?.[1] ?? entry.path;
    const bytes = files.get(entry.path);
    if (!bytes) continue;
    try {
      playlists.push(parseMpls(name, bytes));
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }
  return { playlists, errors };
}

/** Streams without a language in the playlist get the one recorded in the first clip's CLPI. */
async function fillClipLanguages(
  source: DiscSource,
  playlists: MplsPlaylist[],
): Promise<{ playlists: MplsPlaylist[]; warnings: string[] }> {
  const missing = (playlist: MplsPlaylist) =>
    playlist.streams.some((stream) => (stream.kind === 'audio' || stream.kind === 'subtitle') && !stream.language);
  const clipIds = [...new Set(playlists.filter(missing).flatMap((p) => p.playItems.slice(0, 1).map((i) => i.clipId)))];
  if (clipIds.length === 0) return { playlists, warnings: [] };
  const files = await source.readFiles(clipIds.map((clip) => `BDMV/CLIPINF/${clip}.clpi`));
  const warnings = new Set<string>();
  const filled = playlists.map((playlist) => {
    const clipId = playlist.playItems[0]?.clipId;
    const bytes = clipId ? files.get(`BDMV/CLIPINF/${clipId}.clpi`) : undefined;
    if (!clipId || !bytes || !missing(playlist)) return playlist;
    try {
      return withClipLanguages(playlist, parseClpi(clipId, bytes));
    } catch (error) {
      warnings.add(`${clipId}.clpi: ${errorMessage(error)} (languages of ${playlist.name} not filled in)`);
      return playlist;
    }
  });
  return { playlists: filled, warnings: [...warnings] };
}

async function readVolumeLabel(source: DiscSource): Promise<string | null> {
  const metas = source.entries.filter((entry) => META_PATH.test(entry.path));
  const preferred = metas.find((entry) => /bdmt_eng\.xml$/i.test(entry.path)) ?? metas[0];
  if (!preferred) return null;
  const bytes = (await source.readFiles([preferred.path])).get(preferred.path);
  return bytes ? parseDiscTitle(new TextDecoder().decode(bytes)) : null;
}

export async function analyzeDisc(
  source: DiscSource,
  options: { ambiguityPercent: number; extrasMinMinutes: number | null },
): Promise<DiscAnalysis> {
  const encryption = detectEncryption(source.entries.map((entry) => (entry.directory ? `${entry.path}/` : entry.path)));
  const read = await readPlaylists(source);
  const { playlists, warnings } = await fillClipLanguages(source, read.playlists);
  return {
    source,
    encryption,
    playlists,
    parseErrors: read.errors,
    warnings,
    duplicateOf: dedupePlaylists(playlists).duplicateOf,
    pick: pickMainTitle(playlists, options),
    volumeLabel: await readVolumeLabel(source),
  };
}

/**
 * Bytes of the M2TS clips the playlists play; withAngles also counts the other angles (needed when extracting). Each
 * playlist counts its clips once, and clips shared by two playlists count for both: every title is extracted and muxed
 * into its own file.
 */
export function clipBytes(
  entries: readonly DiscEntry[],
  playlists: readonly MplsPlaylist[],
  withAngles: boolean,
): number {
  let total = 0;
  for (const playlist of playlists) {
    const clips = new Set(
      playlist.playItems.flatMap((item) => (withAngles ? [item.clipId, ...item.angleClipIds] : [item.clipId])),
    );
    for (const clip of clips) total += findEntry(entries, `BDMV/STREAM/${clip}.m2ts`)?.sizeBytes ?? 0;
  }
  return total;
}
