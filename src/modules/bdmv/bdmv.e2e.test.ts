/**
 * End to end: author a 190 s Blu-ray with tsMuxeR (folder and .iso), convert it with the real bdmv executor, mkvmerge,
 * ffmpeg (libbluray) and 7z, and check languages, chapters and the untouched video. Skips when a tool is missing, unless
 * WOLOLO_REQUIRE_BDMV_E2E=1 (CI): then missing tools or a disc authored without subtitles fail the run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupSetup, setup } from '../../../test/fixtures/bdmv/service.ts';
import { hasBinary } from '../../../test/helpers/binaries.ts';
import { ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import { createFakeRunContext } from '../../../test/helpers/run-context.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { FfmpegService } from '../../contracts/rules-ffmpeg.ts';
import type { ConversionPlan, MediaStream, PlannedStream, ProbeResult } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { parseMpls } from './mpls.ts';
import { playlistNumber } from './titles.ts';

function ffmpegHasBluray(): boolean {
  if (!ffmpegAvailable()) return false;
  const result = Bun.spawnSync(['ffmpeg', '-hide_banner', '-protocols'], { stdout: 'pipe', stderr: 'ignore' });
  return /^\s*bluray\s*$/m.test(result.stdout.toString());
}

const REQUIRED = process.env.WOLOLO_REQUIRE_BDMV_E2E === '1';
const TOOLS = {
  tsMuxeR: hasBinary('tsMuxeR'),
  mkvmerge: hasBinary('mkvmerge'),
  'ffmpeg with the bluray protocol': ffmpegHasBluray(),
  '7z': hasBinary('7z'),
};
const READY = TOOLS.tsMuxeR && TOOLS.mkvmerge && TOOLS['ffmpeg with the bluray protocol'];

test.if(REQUIRED)('bdmv e2e - every tool is installed when the end-to-end run is required', () => {
  expect(
    Object.entries(TOOLS)
      .filter(([, found]) => !found)
      .map(([name]) => name),
  ).toEqual([]);
});
/** ffmpeg's bluray protocol only opens titles of at least 180 s (MIN_PLAYLIST_LENGTH, not configurable). */
const DURATION = 190;
const PLAYLIST = '00000.mpls';

function exec(argv: string[], cwd?: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0)
    throw new Error(`${argv.join(' ')} failed (${result.exitCode}): ${result.stderr.toString().slice(-1500)}`);
  return result.stdout.toString();
}

function srt(): string {
  return [0, 1, 2]
    .map(
      (i) =>
        `${i + 1}\n00:00:${String(i * 10 + 2).padStart(2, '0')},000 --> 00:00:${String(i * 10 + 6).padStart(2, '0')},000\nLine ${i + 1}\n`,
    )
    .join('\n');
}

/** Elementary streams + tsMuxeR meta: H.264 720p, AC-3 spa, DTS eng, PGS eng (rendered from SRT), chapters 0/10/20 s. */
function authorDisc(work: string, output: string, withSubtitles: boolean): void {
  mkdirSync(work, { recursive: true });
  const ff = ['ffmpeg', '-hide_banner', '-nostdin', '-y', '-v', 'error'];
  exec([
    ...ff,
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=24000/1001:duration=${DURATION}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-x264-params',
    'keyint=24:bluray-compat=1',
    '-bsf:v',
    'h264_mp4toannexb',
    '-f',
    'h264',
    join(work, 'video.h264'),
  ]);
  exec([
    ...ff,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
    '-ac',
    '2',
    '-c:a',
    'ac3',
    '-b:a',
    '192k',
    '-f',
    'ac3',
    join(work, 'spa.ac3'),
  ]);
  exec([
    ...ff,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=660:sample_rate=48000:duration=${DURATION}`,
    '-ac',
    '2',
    '-c:a',
    'dca',
    '-strict',
    '-2',
    '-f',
    'dts',
    join(work, 'eng.dts'),
  ]);
  writeFileSync(join(work, 'eng.srt'), srt());
  const meta = [
    'MUXOPT --no-pcr-on-video-pid --new-audio-pes --blu-ray --vbr --custom-chapters=00:00:00.000;00:00:10.000;00:00:20.000 --vbv-len=500',
    `V_MPEG4/ISO/AVC, "${join(work, 'video.h264')}", fps=23.976, insertSEI, contSPS`,
    `A_AC3, "${join(work, 'spa.ac3')}", lang=spa`,
    `A_DTS, "${join(work, 'eng.dts')}", lang=eng`,
    ...(withSubtitles
      ? [
          `S_TEXT/UTF8, "${join(work, 'eng.srt')}", font-name="DejaVu Sans", font-size=48, font-color=0xffffffff, bottom-offset=24, font-border=2, text-align=center, video-width=1280, video-height=720, fps=23.976, lang=eng`,
        ]
      : []),
  ];
  writeFileSync(join(work, 'disc.meta'), `${meta.join('\n')}\n`);
  exec(['tsMuxeR', join(work, 'disc.meta'), output]);
}

interface FfprobeStream {
  index: number;
  id?: string;
  codec_type: string;
  codec_name?: string;
  channels?: number;
  start_time?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

function ffprobeJson(args: string[]): {
  streams: FfprobeStream[];
  format: { duration?: string };
  chapters?: unknown[];
} {
  return JSON.parse(
    exec(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', ...args]),
  );
}

function toProbe(path: string, args: string[]): ProbeResult {
  const raw = ffprobeJson(args);
  const streams: MediaStream[] = raw.streams.map((s) => {
    const common = {
      index: s.index,
      streamId: s.id ? Number.parseInt(s.id, 16) : null,
      startTimeSec: s.start_time ? Number(s.start_time) : null,
      codec: s.codec_name ?? 'unknown',
      language: normalizeLanguage(s.tags?.language),
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
    };
    if (s.codec_type === 'video') return videoStream(common);
    if (s.codec_type === 'audio') return audioStream({ ...common, channels: s.channels ?? 2 });
    return subtitleStream({ ...common, bitmap: true });
  });
  return probeResult(streams, {
    path,
    durationSec: Number(raw.format.duration ?? 0),
    chapterCount: raw.chapters?.length ?? 0,
  });
}

const discProbe = (disc: string) => toProbe(disc, ['-playlist', String(playlistNumber(PLAYLIST)), `bluray:${disc}`]);

/** The probe as if ffmpeg had tagged nothing: languages must then come from the MPLS stream table. */
const withoutLanguages = (probe: ProbeResult): ProbeResult => ({
  ...probe,
  streams: probe.streams.map((stream) => ({ ...stream, language: null })),
});

function planFor(probe: ProbeResult): ConversionPlan {
  const streams: PlannedStream[] = probe.streams.map((stream) => ({
    sourceIndex: stream.index,
    kind: stream.kind,
    op: stream.codec === 'dts' ? 'encode' : 'copy',
    codec: stream.codec === 'dts' ? 'ac3' : stream.codec,
    encode:
      stream.codec === 'dts'
        ? { codec: 'ac3', bitrateKbps: 448, channels: 2, channelLayout: 'stereo', downmixed: false }
        : null,
    language: stream.language,
    retagged: false,
    title: null,
    default: stream.kind === 'video' || (stream.kind === 'audio' && stream.codec === 'ac3'),
    forced: false,
  }));
  return {
    action: 'convert',
    reasons: ['dts not decoded by profile'],
    failingCodecs: ['dts'],
    streams,
    dropped: [],
    lostFeatures: [],
    videoNotes: [],
    estimatedOutputBytes: null,
    rulesKey: 'e2e',
  };
}

const ffmpegService = stubService<FfmpegService>('ffmpeg', {
  buildAudioConversionArgs: (input) => {
    const stream = input.plan.streams[0] as PlannedStream;
    return [
      '-hide_banner',
      '-nostdin',
      '-y',
      ...(input.inputOptions ?? []),
      '-i',
      input.inputPath,
      '-map',
      `0:${stream.sourceIndex}`,
      '-c:a',
      'ac3',
      '-b:a',
      `${stream.encode?.bitrateKbps ?? 448}k`,
      '-map_chapters',
      '-1',
      '-progress',
      'pipe:1',
      '-nostats',
      '-f',
      'matroska',
      input.outputPath,
    ];
  },
  createProgressParser: () => ({ push: () => null }),
});

function decodedVideoMd5(args: string[]): string {
  return exec(['ffmpeg', '-hide_banner', '-nostdin', '-v', 'error', ...args, '-map', '0:v:0', '-f', 'md5', '-']).trim();
}

describe.skipIf(!READY)('bdmv end to end (tsMuxeR + mkvmerge + ffmpeg/libbluray)', () => {
  let scratch = '';
  let folderDisc = '';
  let hasSubtitles = true;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'wololo-bdmv-e2e-'));
    folderDisc = join(scratch, 'Jamon.Jamon.1992.1080p.BluRay');
    try {
      authorDisc(join(scratch, 'work'), folderDisc, true);
    } catch (error) {
      if (REQUIRED) throw error;
      process.stderr.write(`[bdmv e2e] tsMuxeR could not render subtitles, authoring without them: ${String(error)}\n`);
      rmSync(folderDisc, { recursive: true, force: true });
      hasSubtitles = false;
      authorDisc(join(scratch, 'work'), folderDisc, false);
    }
  }, 180_000);

  afterEach(cleanupSetup);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('parseMpls - reads the tsMuxeR playlist: streams, languages and chapters', () => {
    const playlist = parseMpls(PLAYLIST, new Uint8Array(readFileSync(join(folderDisc, 'BDMV', 'PLAYLIST', PLAYLIST))));
    expect(playlist.durationSec).toBeGreaterThan(DURATION - 1);
    expect(playlist.durationSec).toBeLessThan(DURATION + 1);
    expect(playlist.streams.filter((s) => s.kind === 'audio').map((s) => [s.codec, s.language])).toEqual([
      ['ac3', 'spa'],
      ['dts', 'eng'],
    ]);
    if (hasSubtitles)
      expect(playlist.streams.filter((s) => s.kind === 'subtitle').map((s) => s.language)).toEqual(['eng']);
    expect(playlist.chapterTimesSec.map(Math.round)).toEqual([0, 10, 20]);
  });

  async function convert(disc: string, kind: 'bdmv' | 'iso') {
    const probe = discProbe(disc);
    const s = setup({
      existingDisc: { path: disc, kind },
      plan: (input) => planFor(input.probe),
      probe: (path) => (path.endsWith('.mkv') ? toProbe(path, [path]) : withoutLanguages(probe)),
      overrides: { ffmpeg: ffmpegService },
    });
    const fake = createFakeRunContext({ job: { id: 5, type: 'bdmv', mediaFileId: s.mediaFileId, sourcePath: disc } });
    const outcome = await s.t.ctx.services.bdmv.execute(fake);
    const output = outcome.outputPath as string;
    const result = ffprobeJson([output]);
    const request = fake.verifyRequests[0];

    expect(output).toEndWith('Jamón Jamón (1992)/Jamón Jamón (1992).mkv');
    expect(
      result.streams.map((stream) => [stream.codec_type, stream.codec_name, stream.tags?.language ?? 'und']),
    ).toEqual([
      ['video', 'h264', 'und'],
      ['audio', 'ac3', 'spa'],
      ['audio', 'ac3', 'eng'],
      ...(hasSubtitles ? [['subtitle', 'hdmv_pgs_subtitle', 'eng']] : []),
    ]);
    const audioStarts = result.streams
      .filter((stream) => stream.codec_type === 'audio')
      .map((stream) => Number(stream.start_time ?? 0));
    expect(Math.abs((audioStarts[0] ?? 0) - (audioStarts[1] ?? 0))).toBeLessThan(0.05);
    expect(result.chapters?.length).toBe(3);
    expect(request?.expectedChapterCount).toBe(3);
    expect(Math.abs(Number(result.format.duration) - (request?.expectedDurationSec ?? 0))).toBeLessThan(0.5);
    const outputPackets = Number.parseInt(
      exec([
        'ffprobe',
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets',
        '-of',
        'csv=p=0',
        output,
      ]),
      10,
    );
    expect(request?.expectedVideoPackets).toBe(outputPackets);
    expect(decodedVideoMd5(['-i', output])).toBe(decodedVideoMd5(['-playlist', '0', '-i', `bluray:${disc}`]));
    return { s, fake, output };
  }

  test('bdmv.execute - folder disc becomes one MKV with languages, chapters and the untouched video', async () => {
    const { fake } = await convert(folderDisc, 'bdmv');
    expect(fake.steps.map((step) => step.step)).toContain('encoding');
  }, 300_000);

  test.skipIf(!TOOLS['7z'] && !REQUIRED)(
    'bdmv.execute - .iso disc is extracted with 7z and converted the same way',
    async () => {
      const iso = join(scratch, 'Jamon.Jamon.1992.iso');
      authorDisc(join(scratch, 'work-iso'), iso, hasSubtitles);
      await convert(iso, 'iso');
    },
    300_000,
  );
});
