import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsoReader } from '../../contracts/bdmv.ts';
import { AppError } from '../../core/errors.ts';
import { assertRanOk, type RunOptions, type RunResult } from '../../core/process.ts';
import { parseMpls } from './mpls.ts';

export interface DiscEntry {
  /** Relative to the disc root, "/" separated, original case. */
  path: string;
  sizeBytes: number;
  directory: boolean;
}

/** Pure: `7z l -slt` output -> entries (only the blocks after the "----------" separator describe archive items). */
export function parseSevenZipListing(stdout: string): DiscEntry[] {
  const separator = stdout.search(/^-{10,}\r?$/m);
  if (separator < 0) return [];
  const entries: DiscEntry[] = [];
  for (const block of stdout.slice(separator).split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([A-Za-z ]+?) = (.*)$/.exec(line);
      if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
    }
    const path = fields.get('Path');
    if (!path) continue;
    entries.push({
      path: path.replaceAll('\\', '/').replace(/^\/+/, ''),
      sizeBytes: Number(fields.get('Size') ?? 0) || 0,
      directory: fields.get('Folder') === '+' || (fields.get('Attributes') ?? '').startsWith('D'),
    });
  }
  return entries;
}

/** Case-insensitive lookup of a relative disc path ("BDMV/PLAYLIST/00800.mpls") in a listing. */
export function findEntry(entries: readonly DiscEntry[], path: string): DiscEntry | null {
  const wanted = path.toLowerCase();
  return entries.find((entry) => entry.path.toLowerCase() === wanted) ?? null;
}

/** Files mkvmerge needs to open a playlist: the playlist, its clips' CLPI and M2TS (angles included), the index. */
export function muxFilesForPlaylist(clipIds: readonly string[], playlist: string): string[] {
  const clips = [...new Set(clipIds)];
  return [
    'BDMV/index.bdmv',
    'BDMV/MovieObject.bdmv',
    `BDMV/PLAYLIST/${playlist}`,
    ...clips.map((clip) => `BDMV/CLIPINF/${clip}.clpi`),
    ...clips.map((clip) => `BDMV/STREAM/${clip}.m2ts`),
  ];
}

export type ProcessRunner = (options: RunOptions) => Promise<RunResult>;

export interface SevenZipIsoReader extends IsoReader {
  entries(isoPath: string): Promise<DiscEntry[]>;
  /** Extracts several files in one 7z call; keys are the requested paths. Missing files are left out. Pass the listing already held to skip listing again. */
  readFiles(
    isoPath: string,
    innerPaths: readonly string[],
    listing?: readonly DiscEntry[],
  ): Promise<Map<string, Uint8Array>>;
}

const SEVEN_ZIP_OK_EXIT_CODES = [0, 1] as const;

export function createIsoReader(deps: { sevenZip: string; run: ProcessRunner; tempRoot: string }): SevenZipIsoReader {
  const run = async (args: string[], signal?: AbortSignal): Promise<RunResult> => {
    const result = await deps.run({ command: deps.sevenZip, args, signal });
    assertRanOk(result, {
      label: '7z',
      failureLabel: `7z ${args[0]}`,
      okExitCodes: SEVEN_ZIP_OK_EXIT_CODES,
      failureCode: 'upstream',
      stderrTail: 500,
    });
    return result;
  };

  const entries = async (isoPath: string) => parseSevenZipListing((await run(['l', '-slt', isoPath])).stdout);

  const extract = async (isoPath: string, paths: readonly string[], destDir: string, signal?: AbortSignal) => {
    await mkdir(destDir, { recursive: true });
    const listFile = join(destDir, '.wololo-7z-list.txt');
    await writeFile(listFile, `${paths.join('\n')}\n`);
    try {
      await run(['x', '-y', '-bd', `-o${destDir}`, isoPath, `@${listFile}`], signal);
    } finally {
      await rm(listFile, { force: true });
    }
  };

  const readFiles = async (isoPath: string, innerPaths: readonly string[], known?: readonly DiscEntry[]) => {
    const listing = known ?? (await entries(isoPath));
    const resolved = innerPaths
      .map((path) => ({ path, entry: findEntry(listing, path) }))
      .filter((item): item is { path: string; entry: DiscEntry } => item.entry !== null && !item.entry.directory);
    const files = new Map<string, Uint8Array>();
    if (resolved.length === 0) return files;
    const dir = await mkdtemp(join(deps.tempRoot, 'wololo-7z-'));
    try {
      await extract(
        isoPath,
        resolved.map((item) => item.entry.path),
        dir,
      );
      for (const item of resolved) files.set(item.path, new Uint8Array(await readFile(join(dir, item.entry.path))));
      return files;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  return {
    entries,
    readFiles,
    list: async (isoPath) => (await entries(isoPath)).filter((entry) => !entry.directory).map((entry) => entry.path),
    readFile: async (isoPath, innerPath) => {
      const file = (await readFiles(isoPath, [innerPath])).get(innerPath);
      if (!file) throw new AppError('not_found', `${innerPath} not found in ${isoPath}`);
      return file;
    },
    extractForMux: async (isoPath, playlist, destDir, signal) => {
      const listing = await entries(isoPath);
      const playlistEntry = findEntry(listing, `BDMV/PLAYLIST/${playlist}`);
      if (!playlistEntry) throw new AppError('not_found', `${playlist} not found in ${isoPath}`);
      const mpls = (await readFiles(isoPath, [playlistEntry.path], listing)).get(playlistEntry.path);
      if (!mpls) throw new AppError('not_found', `${playlist} could not be read from ${isoPath}`);
      const clipIds = parseMpls(playlist, mpls).playItems.flatMap((item) => [item.clipId, ...item.angleClipIds]);
      const paths = muxFilesForPlaylist(clipIds, playlist)
        .map((path) => findEntry(listing, path)?.path)
        .filter((path): path is string => path !== undefined);
      await extract(isoPath, paths, destDir, signal);
      return join(destDir, playlistEntry.path);
    },
  };
}
