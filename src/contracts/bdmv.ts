/**
 * Contract: bdmv module (src/modules/bdmv).
 * Owns writes to: bdmv_decisions. Never modifies or deletes the source disc while it seeds.
 * parseMpls, parseClpi, dedupePlaylists, pickMainTitle, detectEncryption, buildMkvmergeArgs and
 * buildOutputPaths are PURE and table-tested (MPLS/CLPI binaries are synthesised in tests, or authored with tsMuxeR in CI).
 */
import type { BdmvDecisionQuery, BdmvDiscInfo } from '../shared/api-types.ts';
import type {
  BdmvDecision,
  BdmvDecisionChoice,
  BdmvJobPlan,
  ConversionPlan,
  DolbyVisionMode,
  MediaFileStatus,
  MovieMatchCandidate,
} from '../shared/domain.ts';
import type { JobExecutor } from './jobs.ts';

export const MPLS_TICKS_PER_SECOND = 45_000;

export interface MplsPlayItem {
  /** Clip file stem, e.g. "00001" (-> STREAM/00001.m2ts, CLIPINF/00001.clpi). */
  clipId: string;
  inTime: number;
  outTime: number;
  durationSec: number;
  /** Angle clips for multi-angle items (seamless branching keeps clip 0). */
  angleClipIds: string[];
  connectionCondition: number;
}

export interface MplsStream {
  kind: 'video' | 'audio' | 'subtitle' | 'interactive' | 'other';
  pid: number;
  /** Raw stream_coding_type, e.g. 0x1b H.264, 0x24 HEVC, 0xea VC-1, 0x80 LPCM, 0x83 TrueHD, 0x86 DTS-HD MA, 0x90 PGS. */
  codingType: number;
  codec: string;
  language: string | null;
  /** MVC dependent view (3D) or Dolby Vision enhancement layer. */
  secondaryVideo: boolean;
}

export interface MplsMark {
  playItemIndex: number;
  /** Absolute time in seconds from the start of the playlist. */
  timeSec: number;
  entryMark: boolean;
}

export interface MplsPlaylist {
  /** File name, e.g. "00800.mpls". */
  name: string;
  durationSec: number;
  playItems: MplsPlayItem[];
  /** Stream table (STN) of the first play item, in disc order. */
  streams: MplsStream[];
  marks: MplsMark[];
  /** Chapter start times (entry marks, deduplicated, < duration). */
  chapterTimesSec: number[];
}

export interface ClipInfo {
  clipId: string;
  streams: {
    pid: number;
    codingType: number;
    codec: string;
    language: string | null;
  }[];
  durationSec: number | null;
}

export type ParseMpls = (name: string, bytes: Uint8Array) => MplsPlaylist;
export type ParseClpi = (clipId: string, bytes: Uint8Array) => ClipInfo;

/** Pure: removes playlists whose clip sequence (and in/out times) duplicates another; keeps the first by name. */
export type DedupePlaylists = (playlists: MplsPlaylist[]) => {
  unique: MplsPlaylist[];
  duplicateOf: Record<string, string>;
};

export interface MainTitlePick {
  main: MplsPlaylist | null;
  /** Unique playlists within ambiguityPercent of the longest (including main); length > 1 means a decision is needed. */
  candidates: MplsPlaylist[];
  extras: MplsPlaylist[];
  ambiguous: boolean;
}

export type PickMainTitle = (
  playlists: MplsPlaylist[],
  options: { ambiguityPercent: number; extrasMinMinutes: number | null },
) => MainTitlePick;

/** Pure: file listing relative to the disc root -> AACS / BD+ markers ("AACS/Unit_Key_RO.inf", "BDSVM/"). */
export type DetectEncryption = (relativePaths: readonly string[]) => {
  encrypted: boolean;
  markers: string[];
};

export interface MkvmergeInput {
  /** Absolute path of the .mpls file; mkvmerge reads playlists directly. */
  playlistPath: string;
  outputPath: string;
  playlist: MplsPlaylist;
  /** Audio tracks of the playlist that the rules engine converts; encoded beforehand by ffmpeg into these files. */
  replacementAudio: {
    sourcePid: number;
    path: string;
    language: string | null;
    title: string | null;
  }[];
  audioPlan: ConversionPlan | null;
  dolbyVision: DolbyVisionMode;
  title: string;
  /** Keep only the 2D base view for MVC discs. */
  dropSecondaryVideo: boolean;
}

/** Pure: mkvmerge argv WITHOUT the binary (--output, --language, --default-track-flag, --forced-display-flag, --track-order, --chapters from playlist). */
export type BuildMkvmergeArgs = (input: MkvmergeInput) => string[];

/** Pure: "<root>/Title (Year)/Title (Year).mkv", editions "Title (Year) {edition-Extended}.mkv", extras "<movie dir>/Featurettes/<name>.mkv". */
export type BuildOutputPaths = (
  rootFolder: string,
  movie: Pick<MovieMatchCandidate, 'title' | 'year'>,
  titles: {
    playlist: string;
    role: 'main' | 'edition' | 'extra';
    edition: string | null;
  }[],
) => string[];

/** Reads an .iso without mounting (container has no privileges). Implementation choice belongs to the bdmv module. */
export interface IsoReader {
  list(isoPath: string): Promise<string[]>;
  readFile(isoPath: string, innerPath: string): Promise<Uint8Array>;
  /** Extracts what mkvmerge needs (playlist + referenced clips) into a temp dir on the same filesystem as the output. */
  extractForMux(
    isoPath: string,
    playlist: string,
    destDir: string,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface BdmvEvaluation {
  status: MediaFileStatus;
  reason: string | null;
  plan: BdmvJobPlan | null;
  decisionId: number | null;
}

export interface BdmvService {
  /** Is this path a disc root (folder containing BDMV/index.bdmv) or a Blu-ray .iso? */
  detect(
    path: string,
  ): Promise<{ kind: 'bdmv' | 'iso'; discRoot: string } | null>;
  analyze(mediaFileId: number): Promise<BdmvDiscInfo>;
  /** Called by media.checkPath for disc rows: encryption check, main title, Radarr match, decisions. */
  evaluate(mediaFileId: number): Promise<BdmvEvaluation>;
  /** Executor for "bdmv" jobs: free-space check, ffmpeg audio, mkvmerge, verify, Radarr import, notifier. */
  execute: JobExecutor;
  listDecisions(query: BdmvDecisionQuery): Promise<BdmvDecision[]>;
  getDecision(id: number): Promise<BdmvDecision>;
  /** Stores the choice, re-evaluates and enqueues the job when processing is enabled. */
  resolveDecision(
    id: number,
    choice: BdmvDecisionChoice,
  ): Promise<BdmvDecision>;
  dismissDecision(id: number): Promise<BdmvDecision>;
}
