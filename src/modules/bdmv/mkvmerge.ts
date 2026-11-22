import { join } from 'node:path';
import { z } from 'zod';
import type {
  BuildMkvmergeArgs,
  BuildOutputPaths,
  MkvmergeIdentify,
  MkvmergeInput,
  MkvmergeOutputTrack,
  MkvmergeTrack,
  ParseMkvmergeIdentify,
} from '../../contracts/bdmv.ts';
import { normalizeLanguage } from '../../shared/language.ts';

const identifySchema = z.object({
  tracks: z
    .array(
      z.object({
        id: z.number().int(),
        type: z.string(),
        codec: z.string().default(''),
        properties: z
          .object({
            number: z.number().int().optional(),
            language: z.string().optional(),
            language_ietf: z.string().optional(),
          })
          .default({}),
      }),
    )
    .default([]),
});

const TRACK_TYPES = new Set<MkvmergeTrack['type']>(['video', 'audio', 'subtitles']);
const isTrackType = (type: string): type is MkvmergeTrack['type'] => TRACK_TYPES.has(type as MkvmergeTrack['type']);

export const parseMkvmergeIdentify: ParseMkvmergeIdentify = (raw) => {
  const parsed = identifySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`unexpected mkvmerge -J output: ${parsed.error.message}`);
  const tracks: MkvmergeTrack[] = [];
  for (const track of parsed.data.tracks) {
    if (!isTrackType(track.type)) continue;
    tracks.push({
      id: track.id,
      type: track.type,
      codec: track.codec,
      pid: track.properties.number ?? null,
      language: normalizeLanguage(track.properties.language ?? track.properties.language_ietf),
    });
  }
  return { tracks };
};

const CODEC_FAMILIES: readonly [RegExp, string][] = [
  [/truehd|mlp/i, 'truehd'],
  [/e-?ac-?3|dolby digital plus/i, 'eac3'],
  [/^ac-?3$|^a_ac3$/i, 'ac3'],
  [/dts/i, 'dts'],
  [/pcm/i, 'pcm'],
  [/avc|h\.?264/i, 'h264'],
  [/hevc|h\.?265/i, 'hevc'],
  [/vc-?1/i, 'vc1'],
  [/mpeg-?1\/2|mpeg[12]video|mpeg-?2/i, 'mpeg2'],
  [/pgs/i, 'pgs'],
  [/text|subrip|srt/i, 'text'],
  [/mp2|mp3|mpeg audio/i, 'mpeg_audio'],
];

/** Shared family of an ffprobe codec name ("truehd") and an mkvmerge codec name ("TrueHD Atmos"). */
export function codecFamily(codec: string): string {
  const name = codec.trim();
  return CODEC_FAMILIES.find(([pattern]) => pattern.test(name))?.[1] ?? name.toLowerCase();
}

function resolvePlaylistTrack(identify: MkvmergeIdentify, request: MkvmergeOutputTrack): MkvmergeTrack {
  const samePid = identify.tracks.filter((track) => track.pid === request.pid);
  const family = request.codec ? codecFamily(request.codec) : null;
  const match = (family && samePid.find((track) => codecFamily(track.codec) === family)) || samePid[0];
  if (!match) throw new Error(`playlist has no mkvmerge track with PID 0x${request.pid.toString(16)}`);
  return match;
}

const flag = (id: number, value: boolean) => `${id}:${value ? 1 : 0}`;

function trackOptions(id: number, track: MkvmergeOutputTrack): string[] {
  const args = ['--language', `${id}:${track.language ?? 'und'}`];
  if (track.title) args.push('--track-name', `${id}:${track.title}`);
  args.push('--default-track-flag', flag(id, track.default), '--forced-display-flag', flag(id, track.forced));
  return args;
}

function selection(option: string, none: string, ids: readonly number[]): string[] {
  return ids.length > 0 ? [option, ids.join(',')] : [none];
}

export function buildMkvmergeArgs(input: MkvmergeInput): string[] {
  const secondaryPids = new Set(
    input.playlist.streams.filter((stream) => stream.secondaryVideo).map((stream) => stream.pid),
  );
  const order: string[] = [];
  const ids: Record<MkvmergeTrack['type'], number[]> = { video: [], audio: [], subtitles: [] };
  const playlistOptions: string[] = [];
  const sideFiles: string[] = [];
  let fileIndex = 0;

  for (const request of input.tracks) {
    if (request.replacementPath !== null) {
      fileIndex += 1;
      sideFiles.push(
        ...trackOptions(0, request),
        '--sync',
        `0:${request.delayMs}`,
        '--no-video',
        '--no-subtitles',
        '--no-chapters',
        '--no-global-tags',
        request.replacementPath,
      );
      order.push(`${fileIndex}:0`);
      continue;
    }
    const track = resolvePlaylistTrack(input.identify, request);
    if (track.type === 'video' && input.dropSecondaryVideo && secondaryPids.has(request.pid)) continue;
    if (ids[track.type].includes(track.id)) continue;
    ids[track.type].push(track.id);
    playlistOptions.push(...trackOptions(track.id, request));
    order.push(`0:${track.id}`);
  }

  return [
    '--output',
    input.outputPath,
    '--title',
    input.title,
    ...selection('--video-tracks', '--no-video', ids.video),
    ...selection('--audio-tracks', '--no-audio', ids.audio),
    ...selection('--subtitle-tracks', '--no-subtitles', ids.subtitles),
    '--no-buttons',
    ...playlistOptions,
    input.playlistPath,
    ...sideFiles,
    '--track-order',
    order.join(','),
  ];
}

buildMkvmergeArgs satisfies BuildMkvmergeArgs;

/** "Progress: 42%" (or "#GUI#progress 42%" in --gui-mode) -> 0.42. */
export function parseMkvmergeProgress(line: string): number | null {
  const match = /^(?:Progress:|#GUI#progress)\s*(\d{1,3})%/.exec(line.trim());
  return match ? Math.min(100, Number(match[1])) / 100 : null;
}

/** mkvmerge exits 0 on success, 1 with warnings (output complete), 2 on error. */
export const MKVMERGE_OK_EXIT_CODES = [0, 1] as const;

export function sanitizeFileName(name: string): string {
  return name
    .replace(/:\s/g, ' - ')
    .replace(/:/g, '-')
    .replace(/[\\/*?"<>|\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

export const buildOutputPaths: BuildOutputPaths = (rootFolder, movie, titles) => {
  const title = sanitizeFileName(movie.title) || 'Unknown';
  const folder = movie.year === null ? title : `${title} (${movie.year})`;
  const movieDir = join(rootFolder, folder);
  const used = new Set<string>();
  return titles.map((entry) => {
    const stem = entry.playlist.replace(/\.mpls$/i, '');
    const edition = entry.edition ? sanitizeFileName(entry.edition) : '';
    const base =
      entry.role === 'extra'
        ? join(movieDir, 'Featurettes', edition || stem)
        : join(movieDir, edition ? `${folder} {edition-${edition}}` : folder);
    const path = used.has(`${base}.mkv`) ? `${base} (${stem}).mkv` : `${base}.mkv`;
    used.add(path);
    return path;
  });
};
