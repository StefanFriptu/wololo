/**
 * Test-only stand-ins for services other modules implement (probe, rules.plan, ffmpeg args and progress), backed by
 * real ffprobe/ffmpeg, so jobs tests pin verify/replace/recover behaviour independently of the rules engine. The run
 * with every real service is test/integration/pipeline.test.ts.
 */
import { statSync } from 'node:fs';
import { z } from 'zod';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { Services } from '../../app/context.ts';
import type { FileChangedEvent, NotifierService } from '../../contracts/integrations.ts';
import type { JobResultUpdate, LibraryService, MediaService, ProbeService } from '../../contracts/probe-scan.ts';
import type {
  AudioConversionInput,
  FfmpegService,
  ProgressParser,
  RulesService,
} from '../../contracts/rules-ffmpeg.ts';
import { notFound } from '../../core/errors.ts';
import type { EventBus } from '../../core/events.ts';
import type { MediaFileDetail } from '../../shared/api-types.ts';
import type {
  ConversionPlan,
  EffectiveProfile,
  Library,
  MediaFileStatus,
  MediaStream,
  PlannedStream,
  ProbeResult,
} from '../../shared/domain.ts';
import type { EventMap, EventName } from '../../shared/events.ts';
import { normalizeLanguage } from '../../shared/language.ts';

const rawSchema = z.object({
  streams: z.array(
    z.object({
      index: z.number(),
      codec_type: z.string(),
      codec_name: z.string().default('unknown'),
      width: z.number().optional(),
      height: z.number().optional(),
      channels: z.number().optional(),
      channel_layout: z.string().optional(),
      tags: z.record(z.string(), z.string()).default({}),
      disposition: z.record(z.string(), z.number()).default({}),
    }),
  ),
  format: z.object({ duration: z.string(), format_name: z.string() }),
  chapters: z.array(z.unknown()).default([]),
});

export async function ffprobeResult(path: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    ['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`ffprobe failed for ${path}`);
  const raw = rawSchema.parse(JSON.parse(text));
  const streams = raw.streams.map((stream): MediaStream => {
    const common = {
      index: stream.index,
      codec: stream.codec_name,
      language: normalizeLanguage(stream.tags.language ?? stream.tags.LANGUAGE),
      title: stream.tags.title ?? null,
      default: stream.disposition.default === 1,
      forced: stream.disposition.forced === 1,
    };
    if (stream.codec_type === 'video')
      return videoStream({ ...common, width: stream.width ?? 0, height: stream.height ?? 0 });
    if (stream.codec_type === 'audio')
      return audioStream({
        ...common,
        channels: stream.channels ?? 2,
        channelLayout: stream.channel_layout ?? null,
      });
    return subtitleStream(common);
  });
  const result = probeResult(streams, {
    path,
    formatName: raw.format.format_name,
    durationSec: Number(raw.format.duration),
    sizeBytes: statSync(path).size,
    chapterCount: raw.chapters.length,
  });
  return { ...result, streams };
}

const LAYOUT_BY_CHANNELS: Record<number, string> = { 1: 'mono', 2: 'stereo', 5: '5.0', 6: '5.1' };

/** Converts every audio stream outside allowed to AC3 (640/448/192 kbps by channels), copies everything else. */
export function ac3Plan(probe: ProbeResult, allowed: readonly string[] = ['ac3', 'aac', 'mp3']): ConversionPlan {
  const streams = probe.streams.map((stream): PlannedStream => {
    const base = {
      sourceIndex: stream.index,
      kind: stream.kind,
      language: stream.language,
      retagged: false,
      title: stream.title,
      default: stream.default,
      forced: stream.forced,
    };
    if (stream.kind !== 'audio' || allowed.includes(stream.codec))
      return { ...base, op: 'copy', codec: stream.codec, encode: null };
    const channels = Math.min(stream.channels, 6);
    const bitrateKbps = channels >= 3 ? 640 : channels === 2 ? 448 : 192;
    return {
      ...base,
      op: 'encode',
      codec: 'ac3',
      encode: {
        codec: 'ac3',
        bitrateKbps,
        channels,
        channelLayout: LAYOUT_BY_CHANNELS[channels] ?? 'stereo',
        downmixed: stream.channels > 6,
      },
    };
  });
  const failing = probe.streams.filter((stream) => stream.kind === 'audio' && !allowed.includes(stream.codec));
  return {
    action: failing.length > 0 ? 'convert' : 'skip',
    reasons: failing.map((stream) => `${stream.codec} not decoded by profile`),
    failingCodecs: failing.map((stream) => stream.codec),
    streams,
    dropped: [],
    lostFeatures: [],
    videoNotes: [],
    estimatedOutputBytes: probe.sizeBytes,
    rulesKey: 'test@1',
  };
}

export function ac3ConversionArgs(input: AudioConversionInput): string[] {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input.inputPath];
  for (const stream of input.plan.streams) args.push('-map', `0:${stream.sourceIndex}`);
  args.push('-c', 'copy');
  input.plan.streams.forEach((stream, outputIndex) => {
    if (!stream.encode) return;
    args.push(
      `-c:${outputIndex}`,
      stream.encode.codec,
      `-b:${outputIndex}`,
      `${stream.encode.bitrateKbps}k`,
      `-ac:${outputIndex}`,
      String(stream.encode.channels),
    );
  });
  args.push(
    '-map_chapters',
    '0',
    '-map_metadata',
    '0',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'matroska',
    input.outputPath,
  );
  return args;
}

export function simpleProgressParser(durationSec: number): ProgressParser {
  let outTimeSec = 0;
  let speed: number | null = null;
  return {
    push(line) {
      const [key, value = ''] = line.trim().split('=');
      if (key === 'out_time_us') outTimeSec = Number(value) / 1e6 || 0;
      if (key === 'speed') speed = Number.parseFloat(value) || null;
      if (key !== 'progress') return null;
      const done = value === 'end';
      const progress = done ? 1 : Math.min(1, durationSec > 0 ? outTimeSec / durationSec : 0);
      const etaSec = speed ? Math.max(0, (durationSec - outTimeSec) / speed) : null;
      return { outTimeSec, progress, speed, etaSec, fps: null, totalSizeBytes: null, done };
    },
  };
}

export interface MediaRecorder {
  files: Map<number, MediaFileDetail>;
  statuses: { id: number; status: MediaFileStatus; reason: string | null }[];
  results: { id: number; update: JobResultUpdate }[];
  ignored: { id: number; ignored: boolean; reason: string | null | undefined }[];
  reprobed: { id: number; status: MediaFileStatus; path: string }[];
}

export function mediaDetail(id: number, path: string, overrides: Partial<MediaFileDetail> = {}): MediaFileDetail {
  return {
    id,
    libraryId: 1,
    path,
    relativePath: path,
    kind: 'file',
    sizeBytes: 1000,
    durationSec: 3,
    status: 'needs_work',
    statusReason: null,
    videoCodec: 'h264',
    audioCodecs: ['dts'],
    subtitleLanguages: [],
    failingCodecs: ['dts'],
    planAction: 'convert',
    lastJobId: null,
    probedAt: null,
    updatedAt: '2026-11-15T00:00:00.000Z',
    probe: null,
    plan: null,
    rulesKey: null,
    originalLanguage: 'eng',
    arr: { instanceId: 1, kind: 'radarr', itemId: 7, fileId: null },
    jobs: [],
    ...overrides,
  };
}

/** A media service that serves the given rows (list honours status and paging), applies and records every write. */
export function recordingMediaService(files: MediaFileDetail[]): { service: MediaService; recorder: MediaRecorder } {
  const recorder: MediaRecorder = {
    files: new Map(files.map((file) => [file.id, file])),
    statuses: [],
    results: [],
    ignored: [],
    reprobed: [],
  };
  const service = stubService<MediaService>('media', {
    get: async (id) => {
      const file = recorder.files.get(id);
      if (!file) throw notFound(`media file ${id}`);
      return file;
    },
    list: async (query) => {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 50;
      const matches = [...recorder.files.values()].filter(
        (file) =>
          (!query.status || file.status === query.status) &&
          (query.libraryId === undefined || file.libraryId === query.libraryId),
      );
      return { page, pageSize, total: matches.length, items: matches.slice((page - 1) * pageSize, page * pageSize) };
    },
    setStatus: async (id, status, reason) => {
      recorder.statuses.push({ id, status, reason });
      const file = recorder.files.get(id);
      if (file) recorder.files.set(id, { ...file, status, statusReason: reason });
    },
    recordJobResult: async (id, update) => {
      recorder.results.push({ id, update });
      const file = recorder.files.get(id);
      if (file)
        recorder.files.set(id, {
          ...file,
          status: update.status,
          statusReason: update.reason,
          lastJobId: update.lastJobId,
          path: update.path ?? file.path,
        });
    },
    reprobe: async (id) => {
      const file = recorder.files.get(id);
      if (!file) throw notFound(`media file ${id}`);
      recorder.reprobed.push({ id, status: file.status, path: file.path });
      return file;
    },
    setIgnored: async (id, ignored, reason) => {
      recorder.ignored.push({ id, ignored, reason });
      const file = recorder.files.get(id);
      if (!file) throw notFound(`media file ${id}`);
      const updated = { ...file, status: ignored ? ('ignored' as const) : ('needs_work' as const) };
      recorder.files.set(id, { ...updated, statusReason: reason ?? null });
      return updated;
    },
  });
  return { service, recorder };
}

const LIBRARY: Library = {
  id: 1,
  name: 'Movies',
  kind: 'movies',
  enabled: true,
  roots: [],
  profileIds: [],
  arrInstanceId: null,
  bdmvEnabled: true,
  discsOnly: false,
  mode: 'replace',
  keepLanguages: [],
  keepOriginalLanguage: true,
  keepUndetermined: true,
  fillMissingLanguage: 'off',
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
};

const EFFECTIVE_PROFILE: EffectiveProfile = {
  profileIds: [1],
  versionKey: '1@1',
  definition: {
    audio: {
      allowedCodecs: ['ac3', 'aac', 'mp3'],
      targetCodec: 'ac3',
      bitrates: { mono: 192, stereo: 448, surround: 640 },
      maxChannels: 6,
    },
    video: { allowedCodecs: ['h264', 'hevc'], dolbyVision: 'drop_hdr10' },
    subtitles: { allowedCodecs: ['subrip'] },
    container: 'mkv',
  },
};

/** probe/libraries/rules/ffmpeg/notifier overrides backed by real ffprobe + ffmpeg and the AC3 test plan. */
export function realMediaToolServices(
  options: {
    libraryRoot?: string;
    args?: (input: AudioConversionInput) => string[];
    notified?: FileChangedEvent[];
  } = {},
): Pick<Services, 'probe' | 'libraries' | 'rules' | 'ffmpeg' | 'notifier'> {
  return {
    probe: stubService<ProbeService>('probe', { probe: (path) => ffprobeResult(path) }),
    libraries: stubService<LibraryService>('libraries', {
      get: async () => LIBRARY,
      findRootForPath: async () =>
        options.libraryRoot ? { library: LIBRARY, rootId: 1, rootPath: options.libraryRoot } : null,
    }),
    rules: stubService<RulesService>('rules', {
      effectiveProfileForLibrary: async () => EFFECTIVE_PROFILE,
      plan: (input) => ac3Plan(input.probe),
    }),
    ffmpeg: stubService<FfmpegService>('ffmpeg', {
      buildAudioConversionArgs: options.args ?? ac3ConversionArgs,
      createProgressParser: simpleProgressParser,
    }),
    notifier: stubService<NotifierService>('notifier', {
      fileChanged: async (event) => {
        options.notified?.push(event);
      },
    }),
  };
}

export function waitForEvent<K extends EventName>(
  events: EventBus,
  name: K,
  predicate: (payload: EventMap[K]) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<EventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${name}`));
    }, timeoutMs);
    const off = events.on(name, (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

export async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}
