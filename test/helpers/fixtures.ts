/**
 * Synthetic media fixtures generated with ffmpeg lavfi sources (testsrc2 + aevalsrc). No copyrighted media.
 * Generated files are cached under test/.cache/fixtures, keyed by a hash of the spec.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasBinary } from './binaries.ts';

export type FixtureAudioCodec = 'ac3' | 'eac3' | 'dts' | 'truehd' | 'flac' | 'aac' | 'pcm_s24le' | 'opus';
export type FixtureLayout = 'mono' | 'stereo' | '5.0' | '5.1' | '7.1';

export interface FixtureAudioTrack {
  codec: FixtureAudioCodec;
  layout: FixtureLayout;
  language?: string;
  title?: string;
  default?: boolean;
  bitrateKbps?: number;
}

export interface FixtureSubtitleTrack {
  language: string;
  title?: string;
  forced?: boolean;
  default?: boolean;
}

export interface FixtureSpec {
  name: string;
  /** Default 3 seconds. */
  durationSec?: number;
  /** null = audio-only file. Default h264 320x240 24 fps. */
  video?: { codec: 'h264' | 'mpeg4'; width?: number; height?: number } | null;
  audio: FixtureAudioTrack[];
  subtitles?: FixtureSubtitleTrack[];
  /** Number of evenly spaced chapters (0 = none). */
  chapters?: number;
  container?: 'mkv' | 'mp4';
}

const FIXTURE_FORMAT_VERSION = 1;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const FIXTURE_CACHE_DIR = join(ROOT, 'test', '.cache', 'fixtures');

const ENCODERS: Record<FixtureAudioCodec, { encoder: string; experimental: boolean }> = {
  ac3: { encoder: 'ac3', experimental: false },
  eac3: { encoder: 'eac3', experimental: false },
  dts: { encoder: 'dca', experimental: true },
  truehd: { encoder: 'truehd', experimental: true },
  flac: { encoder: 'flac', experimental: false },
  aac: { encoder: 'aac', experimental: false },
  pcm_s24le: { encoder: 'pcm_s24le', experimental: false },
  opus: { encoder: 'libopus', experimental: false },
};

const CHANNELS: Record<FixtureLayout, number> = {
  mono: 1,
  stereo: 2,
  '5.0': 5,
  '5.1': 6,
  '7.1': 8,
};

/**
 * Encoders that cannot produce the layout downmix it silently (ffmpeg's truehd/eac3/ac3/dts max out at 5.1),
 * so 7.1 fixtures should use flac, pcm_s24le, aac or opus.
 */
export const MAX_CHANNELS: Record<FixtureAudioCodec, number> = {
  ac3: 6,
  eac3: 6,
  dts: 6,
  truehd: 6,
  flac: 8,
  aac: 8,
  pcm_s24le: 8,
  opus: 8,
};

function aevalsrc(layout: FixtureLayout, durationSec: number, seed: number): string {
  const exprs = Array.from(
    { length: CHANNELS[layout] },
    (_, channel) => `0.2*sin(${220 + seed * 40 + channel * 55}*2*PI*t)`,
  ).join('|');
  return `aevalsrc=exprs='${exprs}':s=48000:c=${layout}:d=${durationSec}`;
}

export function fixtureFileName(spec: FixtureSpec): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ v: FIXTURE_FORMAT_VERSION, spec }))
    .digest('hex')
    .slice(0, 10);
  return `${spec.name}-${hash}.${spec.container ?? 'mkv'}`;
}

export function srtContent(durationSec: number, language: string): string {
  const end = Math.max(1, Math.floor(durationSec) - 1);
  return `1\n00:00:00,500 --> 00:00:0${Math.min(end, 9)},000\nWololo subtitle (${language})\n`;
}

export function chaptersMetadata(durationSec: number, count: number): string {
  const lines = [';FFMETADATA1'];
  const step = Math.floor((durationSec * 1000) / count);
  for (let i = 0; i < count; i++) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${i * step}`,
      `END=${i === count - 1 ? Math.round(durationSec * 1000) : (i + 1) * step}`,
      `title=Chapter ${i + 1}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Pure: ffmpeg argv (without the binary) for a fixture. Side files (srt, ffmetadata) are passed in by path. */
export function buildFixtureArgs(
  spec: FixtureSpec,
  outputPath: string,
  sideFiles: { subtitles: string[]; chapters: string | null },
): string[] {
  const duration = spec.durationSec ?? 3;
  const video = spec.video === undefined ? { codec: 'h264' as const } : spec.video;
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  const maps: string[] = [];
  let input = 0;

  if (video) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${video.width ?? 320}x${video.height ?? 240}:rate=24:duration=${duration}`,
    );
    maps.push('-map', `${input++}:v`);
  }
  spec.audio.forEach((track, i) => {
    args.push('-f', 'lavfi', '-i', aevalsrc(track.layout, duration, i));
    maps.push('-map', `${input++}:a`);
  });
  for (const path of sideFiles.subtitles) {
    args.push('-i', path);
    maps.push('-map', `${input++}:s`);
  }
  let chapterInput: number | null = null;
  if (sideFiles.chapters) {
    args.push('-i', sideFiles.chapters);
    chapterInput = input++;
  }

  args.push(...maps);
  if (chapterInput !== null) args.push('-map_chapters', String(chapterInput));
  if (video) {
    args.push(
      ...(video.codec === 'h264'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'mpeg4', '-q:v', '5']),
      '-disposition:v:0',
      'default',
    );
  }

  let experimental = false;
  spec.audio.forEach((track, i) => {
    const { encoder, experimental: exp } = ENCODERS[track.codec];
    experimental ||= exp;
    args.push(`-c:a:${i}`, encoder);
    if (track.bitrateKbps) args.push(`-b:a:${i}`, `${track.bitrateKbps}k`);
    if (track.language) args.push(`-metadata:s:a:${i}`, `language=${track.language}`);
    if (track.title) args.push(`-metadata:s:a:${i}`, `title=${track.title}`);
    args.push(`-disposition:a:${i}`, (track.default ?? i === 0) ? 'default' : '0');
  });
  if (experimental) args.push('-strict', '-2');

  (spec.subtitles ?? []).forEach((track, i) => {
    args.push(`-c:s:${i}`, spec.container === 'mp4' ? 'mov_text' : 'srt');
    args.push(`-metadata:s:s:${i}`, `language=${track.language}`);
    if (track.title) args.push(`-metadata:s:s:${i}`, `title=${track.title}`);
    const flags = [track.default ? 'default' : '', track.forced ? 'forced' : ''].filter(Boolean).join('+');
    args.push(`-disposition:s:${i}`, flags || '0');
  });

  args.push(outputPath);
  return args;
}

export function ffmpegAvailable(): boolean {
  return hasBinary('ffmpeg') && hasBinary('ffprobe');
}

/** Generates (or reuses) a fixture and returns its absolute path. Throws when ffmpeg is missing: guard with ffmpegAvailable(). */
export async function ensureFixture(spec: FixtureSpec): Promise<string> {
  mkdirSync(FIXTURE_CACHE_DIR, { recursive: true });
  const output = join(FIXTURE_CACHE_DIR, fixtureFileName(spec));
  if (existsSync(output)) return output;

  const duration = spec.durationSec ?? 3;
  const work = join(FIXTURE_CACHE_DIR, `.work-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(work, { recursive: true });
  try {
    const subtitles = (spec.subtitles ?? []).map((track, i) => {
      const path = join(work, `sub${i}.srt`);
      writeFileSync(path, srtContent(duration, track.language));
      return path;
    });
    let chapters: string | null = null;
    if (spec.chapters && spec.chapters > 0) {
      chapters = join(work, 'chapters.txt');
      writeFileSync(chapters, chaptersMetadata(duration, spec.chapters));
    }
    const temp = join(work, `out.${spec.container ?? 'mkv'}`);
    const proc = Bun.spawn(['ffmpeg', ...buildFixtureArgs(spec, temp, { subtitles, chapters })], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`fixture ${spec.name} failed (${exitCode}): ${stderr.trim()}`);
    renameSync(temp, output);
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Copies a cached fixture into dir (default name: the cache file name) and returns the copy's path. Use it for every
 * test that renames, replaces, recycles or deletes the file, so the shared cache stays intact.
 */
export async function ensureFixtureCopy(spec: FixtureSpec, dir: string, name?: string): Promise<string> {
  const source = await ensureFixture(spec);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name ?? fixtureFileName(spec));
  copyFileSync(source, target);
  return target;
}

/** Shared catalogue; define module-local specs in your own tests. */
export const FIXTURES = {
  dts51: {
    name: 'dts51',
    audio: [{ codec: 'dts', layout: '5.1', language: 'eng', title: 'DTS 5.1' }],
    subtitles: [{ language: 'eng' }],
    chapters: 3,
  },
  truehd51PlusAc3: {
    name: 'truehd51-ac3',
    audio: [
      { codec: 'truehd', layout: '5.1', language: 'eng', title: 'TrueHD 5.1' },
      {
        codec: 'ac3',
        layout: '5.1',
        language: 'eng',
        title: 'AC3 5.1',
        default: false,
      },
    ],
  },
  eac3Stereo: {
    name: 'eac3-stereo',
    audio: [{ codec: 'eac3', layout: 'stereo', language: 'eng' }],
  },
  ac3Compatible: {
    name: 'ac3-51',
    audio: [{ codec: 'ac3', layout: '5.1', language: 'eng' }],
  },
  aacStereo: {
    name: 'aac-stereo',
    audio: [{ codec: 'aac', layout: 'stereo', language: 'eng' }],
    container: 'mp4',
  },
  flacMono: {
    name: 'flac-mono',
    audio: [{ codec: 'flac', layout: 'mono', language: 'ger' }],
  },
  pcm71: {
    name: 'pcm71',
    audio: [{ codec: 'pcm_s24le', layout: '7.1', language: 'eng' }],
  },
  flac71: {
    name: 'flac71',
    audio: [{ codec: 'flac', layout: '7.1', language: 'eng' }],
  },
  opusStereo: {
    name: 'opus-stereo',
    audio: [{ codec: 'opus', layout: 'stereo', language: 'fre' }],
  },
  multiLanguage: {
    name: 'multi-language',
    audio: [
      { codec: 'dts', layout: '5.1', language: 'spa', title: 'Castellano DTS' },
      {
        codec: 'ac3',
        layout: 'stereo',
        language: 'eng',
        title: 'English',
        default: false,
      },
      { codec: 'aac', layout: 'stereo', language: 'ger', default: false },
    ],
    subtitles: [{ language: 'eng' }, { language: 'spa', forced: true }, { language: 'ger' }],
    chapters: 4,
  },
  untaggedLanguage: {
    name: 'untagged',
    audio: [{ codec: 'dts', layout: 'stereo' }],
  },
} satisfies Record<string, FixtureSpec>;

export type FixtureName = keyof typeof FIXTURES;
