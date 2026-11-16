/** Shared setup for bdmv service and executor tests: a synthetic disc folder, a seeded row and stubbed services. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../../../src/app/context.ts';
import type {
  ArrService,
  DownloadClientService,
  NotifierService,
  PathMappingService,
} from '../../../src/contracts/integrations.ts';
import type { JobsService } from '../../../src/contracts/jobs.ts';
import type { LibraryService, MediaService, ProbeService } from '../../../src/contracts/probe-scan.ts';
import type { FfmpegService, RulesInput, RulesService } from '../../../src/contracts/rules-ffmpeg.ts';
import type { MediaFileSummary } from '../../../src/shared/api-types.ts';
import type {
  ArrInstance,
  ConversionPlan,
  EffectiveProfile,
  Library,
  MovieMatchCandidate,
  PlannedStream,
  ProbeResult,
  TorrentInfo,
} from '../../../src/shared/domain.ts';
import type { DeepPartial, Settings } from '../../../src/shared/settings.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../helpers/probe.ts';
import { insertLibrary, insertMediaFile } from '../../helpers/seed.ts';
import { stubService } from '../../helpers/stubs.ts';
import { writeDiscFolder } from './disc.ts';
import type { MplsSpec, StnSpec } from './writers.ts';

export const T = 45_000;
export const STN: StnSpec = {
  video: [{ pid: 0x1011, codingType: 0x1b }],
  audio: [{ pid: 0x1100, codingType: 0x86, language: 'spa' }],
  pg: [{ pid: 0x1200, codingType: 0x90, language: 'eng' }],
};
export const feature = (clipId: string, seconds: number): MplsSpec => ({
  playItems: [{ clipId, inTime: 0, outTime: seconds * T, stn: STN }],
  marks: [
    { playItem: 0, time: 0 },
    { playItem: 0, time: 600 * T },
  ],
});

export const RADARR: ArrInstance = {
  id: 7,
  kind: 'radarr',
  name: 'Radarr',
  url: 'http://radarr:7878',
  apiKey: '********',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const JAMON: MovieMatchCandidate = {
  title: 'Jamón Jamón',
  year: 1992,
  tmdbId: 4517,
  imdbId: 'tt0104545',
  score: 0.95,
  radarrMovieId: null,
};

export const PROFILE: EffectiveProfile = {
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
    subtitles: { allowedCodecs: [] },
    container: 'mkv',
  },
};

export const PROBE = probeResult(
  [
    videoStream({ streamId: 0x1011 }),
    audioStream({ streamId: 0x1100, codec: 'dts', language: 'spa' }),
    subtitleStream({ streamId: 0x1200, codec: 'hdmv_pgs_subtitle', language: 'eng', bitmap: true }),
  ],
  { durationSec: 5706, formatName: 'mpegts' },
);

export function conversionPlan(action: ConversionPlan['action'] = 'convert'): ConversionPlan {
  return {
    action,
    reasons:
      action === 'blocked' ? ['video codec vc1 not decoded by profile'] : ['dts (spa, 5.1) not decoded by profile'],
    failingCodecs: ['dts'],
    streams: [],
    dropped: [],
    lostFeatures: [],
    videoNotes: [],
    estimatedOutputBytes: null,
    rulesKey: 'k',
  };
}

/** Copies every video, audio and subtitle stream of the probe with the probe's language, as a rules plan would. */
export function planFromProbe(probe: ProbeResult): ConversionPlan {
  const streams = probe.streams.flatMap((stream): PlannedStream[] =>
    stream.kind === 'video' || stream.kind === 'audio' || stream.kind === 'subtitle'
      ? [
          {
            sourceIndex: stream.index,
            kind: stream.kind,
            op: 'copy',
            codec: stream.codec,
            encode: null,
            language: stream.language,
            retagged: false,
            title: null,
            default: stream.kind !== 'subtitle',
            forced: false,
          },
        ]
      : [],
  );
  return { ...conversionPlan(), streams };
}

export const SUMMARY: MediaFileSummary = {
  id: 0,
  libraryId: 1,
  path: '/disc',
  relativePath: 'disc',
  kind: 'bdmv',
  sizeBytes: 0,
  durationSec: null,
  status: 'pending',
  statusReason: null,
  videoCodec: null,
  audioCodecs: [],
  subtitleLanguages: [],
  failingCodecs: [],
  planAction: null,
  lastJobId: null,
  probedAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export interface Setup {
  t: TestContext;
  root: string;
  disc: string;
  mediaFileId: number;
  library: Library;
  calls: Record<string, unknown[][]>;
  lookups: MovieMatchCandidate[];
}

let current: TestContext | null = null;

/** Register with afterEach in each test file. */
export function cleanupSetup(): void {
  current?.cleanup();
  current = null;
}

export function setup(
  options: {
    playlists?: Record<string, MplsSpec>;
    files?: Record<string, string>;
    settings?: DeepPartial<Settings>;
    lookups?: MovieMatchCandidate[];
    /** Fixed plan, or a function of the rules input; default planFromProbe(input.probe). */
    plan?: ConversionPlan | ((input: RulesInput) => ConversionPlan);
    radarr?: ArrInstance | null;
    /** Torrent found for the looked-up path (or a function of it). */
    torrent?: TorrentInfo | null | ((path: string) => TorrentInfo | null);
    arr?: Partial<ArrService>;
    probe?: (path: string, options?: { playlist?: string }) => ProbeResult | Promise<ProbeResult>;
    overrides?: Partial<Services>;
    /** Folder name of the synthetic disc below the library root. */
    discName?: string;
    env?: Record<string, string>;
    /** Use an existing disc (e.g. authored with tsMuxeR) instead of the synthetic folder. */
    existingDisc?: { path: string; kind: 'bdmv' | 'iso' };
  } = {},
): Setup {
  const calls: Record<string, unknown[][]> = {};
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls[name] ??= [];
      calls[name].push(args);
      return fn(...args);
    };
  const lookups = options.lookups ?? [JAMON];
  const holder: { library?: Library } = {};
  const t = createTestContext({
    settings: options.settings,
    env: options.env,
    overrides: {
      libraries: stubService<LibraryService>('libraries', {
        get: async () => holder.library as Library,
      }),
      arr: stubService<ArrService>('arr', {
        get: async () => RADARR,
        defaultRadarr: async () => (options.radarr === undefined ? RADARR : options.radarr),
        lookupMovie: record('lookupMovie', async (_id: number, term: string) =>
          term.startsWith('tmdb:') ? lookups.filter((m) => `tmdb:${m.tmdbId}` === term) : lookups,
        ),
        rootFolders: async () => [
          { id: 1, path: '/remote/other', localPath: '/elsewhere', accessible: true, freeBytes: null },
          {
            id: 2,
            path: '/remote/movies',
            localPath: holder.library?.roots[0]?.path ?? '/missing',
            accessible: true,
            freeBytes: null,
          },
        ],
        addMovie: record('addMovie', async () => 99),
        importMovieFolder: record('importMovieFolder', async () => {}),
        rescan: record('rescan', async () => {}),
        ...options.arr,
      }),
      probe: stubService<ProbeService>('probe', {
        probe: record('probe', async (path: string, probeOptions?: { playlist?: string }) =>
          options.probe ? options.probe(path, probeOptions) : PROBE,
        ),
      }),
      ffmpeg: stubService<FfmpegService>('ffmpeg', {
        buildAudioConversionArgs: record('buildAudioConversionArgs', (input) => [
          ...(input.inputOptions ?? []),
          '-i',
          input.inputPath,
          '-c:a',
          'ac3',
          input.outputPath,
        ]),
        createProgressParser: (durationSec: number) => ({
          push: (line: string) =>
            line === 'progress=end'
              ? {
                  outTimeSec: durationSec,
                  progress: 1,
                  speed: 7.7,
                  etaSec: 0,
                  fps: null,
                  totalSizeBytes: null,
                  done: true,
                }
              : null,
        }),
      }),
      notifier: stubService<NotifierService>('notifier', { fileChanged: record('fileChanged', async () => {}) }),
      rules: stubService<RulesService>('rules', {
        effectiveProfileForLibrary: async () => PROFILE,
        plan: record('rulesPlan', (input: RulesInput) => {
          const plan = options.plan;
          if (typeof plan === 'function') return plan(input);
          return plan ?? planFromProbe(input.probe);
        }),
      }),
      media: stubService<MediaService>('media', {
        checkPath: record('checkPath', async () => ({
          action: 'queued' as const,
          mediaFile: null,
          jobId: 9,
          message: '',
        })),
        setIgnored: record('setIgnored', async (id: number) => ({ ...SUMMARY, id, status: 'ignored' as const })),
        recordJobResult: record('recordJobResult', async () => {}),
      }),
      pathMappings: stubService<PathMappingService>('pathMappings', {
        toLocal: record('toLocal', async (_scope: string, path: string) => path),
      }),
      jobs: stubService<JobsService>('jobs', { addHistory: record('addHistory', async () => {}) }),
      downloadClient: stubService<DownloadClientService>('downloadClient', {
        findTorrentByPath: async (path: string) =>
          (typeof options.torrent === 'function' ? options.torrent(path) : options.torrent) ?? null,
        deleteTorrent: record('deleteTorrent', async () => {}),
      }),
      ...options.overrides,
    },
  });
  current = t;
  const root = join(t.dir, 'movies');
  mkdirSync(root, { recursive: true });
  const disc =
    options.existingDisc?.path ??
    writeDiscFolder(join(root, options.discName ?? 'Jamon.Jamon.1992.1080p.BluRay.x264-GRP'), {
      playlists: options.playlists ?? { '00800.mpls': feature('00001', 5706) },
      clips: { '00001': { streamBytes: 5000 }, '00002': { streamBytes: 3000 } },
      files: options.files,
    });
  const seeded = insertLibrary(t.ctx.db, { roots: [root] });
  holder.library = {
    id: seeded.libraryId,
    name: 'Movies',
    kind: 'movies',
    enabled: true,
    roots: [{ id: seeded.rootIds[0] as number, path: root, freeBytes: null, accessible: true }],
    profileIds: [],
    arrInstanceId: null,
    bdmvEnabled: true,
    discsOnly: false,
    mode: 'replace',
    keepLanguages: [],
    keepOriginalLanguage: true,
    keepUndetermined: true,
    fillMissingLanguage: 'off',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const row = insertMediaFile(t.ctx.db, seeded, {
    path: disc,
    kind: options.existingDisc?.kind ?? 'bdmv',
    originalLanguage: 'spa',
  });
  return { t, root, disc, mediaFileId: row.id, library: holder.library, calls, lookups };
}
