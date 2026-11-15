/**
 * Contract: bdmv module (src/modules/bdmv).
 * Owns writes to: bdmv_decisions. Never modifies the source disc; deletes it only through a confirmed delete_source
 * decision (deleteSource below).
 * parseMpls, parseClpi, parseMkvmergeIdentify, dedupePlaylists, pickMainTitle, detectEncryption, cleanDiscName,
 * countForcedPgsCompositions, buildMkvmergeArgs and buildOutputPaths are PURE and table-tested (MPLS/CLPI binaries are
 * synthesised in tests, or authored with tsMuxeR in CI).
 *
 * Tools: mkvmerge reads .mpls playlists of a disc folder directly. An .iso is read with 7z (ToolPaths.sevenZip, reads
 * UDF 2.50): listing and single files without extraction, and extractForMux copies the playlist + its clips into the
 * job's temp dir for mkvmerge. ffprobe/ffmpeg read both folders and .iso through libbluray: `-playlist N bluray:<path>`.
 *
 * Track identity: ffprobe on bluray: reports each stream's PID as MediaStream.streamId; MplsStream.pid is the same PID;
 * `mkvmerge -J <playlist>` maps PIDs to mkvmerge track ids (MkvmergeIdentify). The rules engine plans on the bluray:
 * probe, so PlannedStream.sourceIndex -> probe stream -> streamId -> MplsStream.pid -> mkvmerge track id.
 */
import type { BdmvDecisionQuery, BdmvDiscInfo } from '../shared/api-types.ts';
import type {
  BdmvDecision,
  BdmvDecisionChoice,
  BdmvJobPlan,
  Iso639_2,
  MediaFileStatus,
  MovieMatchCandidate,
  TorrentInfo,
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
  /** Normalised with normalizeLanguage. */
  language: Iso639_2 | null;
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
  /** Stream table (STN) of the first play item, in disc order (this is the track order kept in the output). */
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
    language: Iso639_2 | null;
  }[];
  durationSec: number | null;
}

export type ParseMpls = (name: string, bytes: Uint8Array) => MplsPlaylist;
export type ParseClpi = (clipId: string, bytes: Uint8Array) => ClipInfo;

/** One track of `mkvmerge -J <file.mpls>`. pid = properties.number (the MPEG-TS PID for playlist input). */
export interface MkvmergeTrack {
  id: number;
  type: 'video' | 'audio' | 'subtitles';
  codec: string;
  pid: number | null;
  language: Iso639_2 | null;
}

export interface MkvmergeIdentify {
  tracks: MkvmergeTrack[];
}

/** Pure: parsed `mkvmerge -J` JSON -> tracks (languages normalised). */
export type ParseMkvmergeIdentify = (raw: unknown) => MkvmergeIdentify;

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

/**
 * Pure: disc folder / .iso / volume label -> Radarr lookup term.
 * "Jamon.Jamon.1992.1080p.BluRay.x264-GRP" -> { title: "Jamon Jamon", year: 1992 }; "JAMON_JAMON" -> { title: "Jamon Jamon", year: null }.
 */
export type CleanDiscName = (name: string) => { title: string; year: number | null };

/**
 * Pure: counts PGS presentation composition segments in a .sup buffer (ffmpeg `-map 0:<idx> -c copy -f sup`) and how
 * many have the forced_on flag. A track whose compositions are all forced (and > 0) is muxed with the forced flag.
 * Only scanned when the main playlist has more than one subtitle track in the same language.
 */
export type CountForcedPgsCompositions = (sup: Uint8Array) => { compositions: number; forced: number };

/** One output track, in output order. Playlist tracks not listed are dropped. */
export interface MkvmergeOutputTrack {
  /** PID of the playlist track; for a replacement, the PID of the source track it was encoded from. */
  pid: number;
  /** Side file (.mka written by ffmpeg) that replaces the playlist track; null = take the track from the playlist. */
  replacementPath: string | null;
  /** mkvmerge --sync for the side file in ms: round((audio startTimeSec - video startTimeSec) * 1000) from the bluray: probe. */
  delayMs: number;
  language: Iso639_2 | null;
  title: string | null;
  default: boolean;
  forced: boolean;
}

export interface MkvmergeInput {
  /** Absolute path of the .mpls file (inside the disc folder, or inside the job temp dir for an .iso). */
  playlistPath: string;
  outputPath: string;
  playlist: MplsPlaylist;
  /** `mkvmerge -J` of playlistPath, run by the bdmv executor through JobRunContext.run. */
  identify: MkvmergeIdentify;
  /** Video first, then audio and subtitles as planned (rules engine order for audio, disc order for subtitles). */
  tracks: MkvmergeOutputTrack[];
  title: string;
  /** Keep only the base video track: drops the MVC dependent view (3D) and the Dolby Vision enhancement layer. */
  dropSecondaryVideo: boolean;
}

/**
 * Pure: mkvmerge argv WITHOUT the binary: --output, --title, per playlist track id --language, --track-name,
 * --default-track-flag, --forced-display-flag, --audio-tracks/--subtitle-tracks/--video-tracks selections, per side file
 * --sync 0:<delayMs> and its flags, --track-order <file>:<tid>,... ; chapters come from the playlist itself.
 */
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

/** Reads an .iso without mounting (the container has no privileges), with 7z. */
export interface IsoReader {
  list(isoPath: string): Promise<string[]>;
  readFile(isoPath: string, innerPath: string): Promise<Uint8Array>;
  /** Extracts the playlist + referenced clips (BDMV/ tree layout) into destDir (the job temp dir); returns the .mpls path. */
  extractForMux(isoPath: string, playlist: string, destDir: string, signal: AbortSignal): Promise<string>;
}

export interface BdmvEvaluation {
  status: MediaFileStatus;
  reason: string | null;
  plan: BdmvJobPlan | null;
  decisionId: number | null;
}

export interface BdmvService {
  /** Is this path a disc root (folder containing BDMV/index.bdmv) or a Blu-ray .iso? */
  detect(path: string): Promise<{ kind: 'bdmv' | 'iso'; discRoot: string } | null>;
  analyze(mediaFileId: number): Promise<BdmvDiscInfo>;
  /**
   * Called by media.checkPath for disc rows (kind bdmv|iso) AFTER checkPath created/updated the media_files row.
   * Encryption check -> main title -> cleanDiscName + Radarr lookup -> bluray: probe + rules.plan -> decisions.
   * A disc that already has a completed bdmv job returns status "compatible", reason "converted to <output>", so scans and
   * profile edits never convert it twice. checkPath enqueues the returned plan (status needs_work) when processing is on.
   */
  evaluate(mediaFileId: number): Promise<BdmvEvaluation>;
  /**
   * Executor for "bdmv" jobs. Steps: preparing (re-analyze, setTempPath("<root>/.wololo-tmp-<jobId>/"),
   * ensureFreeSpace(root, extractBytes + estimatedOutputBytes), .iso extraction, forced-PGS scan) -> encoding (ffmpeg side
   * files via ffmpeg.buildAudioConversionArgs with inputOptions ["-playlist", N]) -> muxing (mkvmerge -J, buildMkvmergeArgs)
   * -> verifying (duration, stream count, video packets, chapters, languages, audio decode) -> rename into
   * "<root>/Title (Year)/", setTempPath(null), delete the temp dir -> importing (arr.addMovie when radarrMovieId is null,
   * then arr.importMovieFolder) -> media.recordJobResult(disc row: status compatible, reason "converted to <output>",
   * path unchanged) -> notifier.fileChanged({ kind: 'created' }).
   */
  execute: JobExecutor;
  listDecisions(query: BdmvDecisionQuery): Promise<BdmvDecision[]>;
  getDecision(id: number): Promise<BdmvDecision>;
  /** Stores the choice, re-evaluates and enqueues the job when processing is enabled; delete_source + confirm calls deleteSource. */
  resolveDecision(id: number, choice: BdmvDecisionChoice): Promise<BdmvDecision>;
  dismissDecision(id: number): Promise<BdmvDecision>;
  /**
   * Called by downloadClient.checkSeedingGoals for a converted disc (completed bdmv job) whose torrent met its goal,
   * when settings.bdmv.deleteSourceWhenSeeded is on. Creates one pending delete_source decision (idempotent).
   */
  offerSourceDeletion(mediaFileId: number, torrent: TorrentInfo): Promise<BdmvDecision | null>;
  /**
   * Only after a resolved delete_source decision with confirm: downloadClient.deleteTorrent(hash, true) when a torrent
   * still owns the path, else removes the folder / .iso itself; writes a "source_deleted" history entry. The next scan
   * removes the media_files row.
   */
  deleteSource(mediaFileId: number): Promise<void>;
}
