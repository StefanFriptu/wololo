/**
 * Domain model shared by the backend and the web UI.
 * Must stay free of runtime imports (no bun, node, drizzle): the SvelteKit app type-checks this file.
 * Language codes are ISO 639-2/B three-letter codes ("eng", "ger", "spa"). Every language value from outside
 * (ffprobe, MPLS, mkvmerge, Radarr/Sonarr names, user input) goes through normalizeLanguage (./language.ts) first.
 */

export type Iso639_2 = string;
export type IsoDateTime = string;

/**
 * blocked: the plan needs work that cannot be done automatically (ConversionPlan.action "blocked", e.g. a video codec
 * outside the profile); never queued by "Process all needs-work" or the scan backlog.
 */
export const MEDIA_FILE_STATUSES = [
  'pending',
  'compatible',
  'needs_work',
  'blocked',
  'processing',
  'failed',
  'ignored',
] as const;
export type MediaFileStatus = (typeof MEDIA_FILE_STATUSES)[number];

export const SORT_DIRS = ['asc', 'desc'] as const;
export type SortDir = (typeof SORT_DIRS)[number];

export const MEDIA_FILE_KINDS = ['file', 'bdmv', 'iso'] as const;
export type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];

export const LIBRARY_MODES = ['replace', 'keep_both'] as const;
export type LibraryMode = (typeof LIBRARY_MODES)[number];

export const LIBRARY_KINDS = ['movies', 'series', 'other'] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const STREAM_KINDS = ['video', 'audio', 'subtitle', 'attachment', 'data'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

export type HdrFormat = 'sdr' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dolby_vision';

export interface DolbyVisionInfo {
  profile: number;
  level: number;
  rpuPresent: boolean;
  elPresent: boolean;
  blPresent: boolean;
  blSignalCompatibilityId: number;
}

interface StreamBase {
  /** Absolute stream index inside the container (ffprobe `index`). */
  index: number;
  /** Container stream id (ffprobe `id`, hex "0x1100" parsed to 4352): the MPEG-TS PID for m2ts and bluray: probes, else null. */
  streamId: number | null;
  /** ffprobe `start_time` in seconds; audio/video offsets of a disc are derived from it. */
  startTimeSec: number | null;
  /** ffprobe `codec_name`, lower case ("dts", "truehd", "eac3", "pcm_s24le", "hevc", "subrip"). */
  codec: string;
  codecLongName: string | null;
  /** ffprobe `profile`, e.g. "DTS-HD MA", "Dolby TrueHD + Dolby Atmos", "Main 10". */
  profile: string | null;
  language: Iso639_2 | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  bitRate: number | null;
  durationSec: number | null;
}

export interface VideoStream extends StreamBase {
  kind: 'video';
  width: number;
  height: number;
  frameRate: number | null;
  pixelFormat: string | null;
  bitDepth: number | null;
  hdr: HdrFormat;
  dolbyVision: DolbyVisionInfo | null;
  /** Cover art and other attached pictures are reported by ffprobe as video with disposition attached_pic. */
  attachedPicture: boolean;
  /** Stereoscopic MVC dependent view or other 3D marker detected. */
  stereo3d: boolean;
}

export interface AudioStream extends StreamBase {
  kind: 'audio';
  channels: number;
  channelLayout: string | null;
  sampleRate: number;
  bitsPerSample: number | null;
  /** Object audio detected from the profile string (TrueHD Atmos, E-AC3 JOC, DTS:X). */
  objectAudio: 'atmos' | 'dtsx' | null;
  lossless: boolean;
}

export interface SubtitleStream extends StreamBase {
  kind: 'subtitle';
  /** Picture-based subtitle (PGS, VobSub, DVB). */
  bitmap: boolean;
  hearingImpaired: boolean;
}

export interface OtherStream extends StreamBase {
  kind: 'attachment' | 'data';
  filename: string | null;
  mimeType: string | null;
}

export type MediaStream = VideoStream | AudioStream | SubtitleStream | OtherStream;

export interface ProbeResult {
  path: string;
  /** ffprobe `format_name`, e.g. "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2", "mpegts". */
  formatName: string;
  durationSec: number;
  sizeBytes: number;
  bitRate: number | null;
  chapterCount: number;
  streams: MediaStream[];
  tags: Record<string, string>;
  probedAt: IsoDateTime;
}

export const TARGET_AUDIO_CODECS = ['ac3', 'eac3', 'aac'] as const;
export type TargetAudioCodec = (typeof TARGET_AUDIO_CODECS)[number];
/**
 * Handling of dual-layer Dolby Vision (UHD Blu-ray profile 7) in BDMV jobs. v1 ships only "drop_hdr10": keep the
 * HDR10 base layer, drop the enhancement layer. "keep" and "convert_8_1" need dovi_tool and are v1.1.
 * Files handled by audio jobs always copy video untouched, Dolby Vision included.
 */
export const DOLBY_VISION_MODES = ['drop_hdr10'] as const;
export type DolbyVisionMode = (typeof DOLBY_VISION_MODES)[number];

export interface AudioBitrates {
  /** kbps for 1 channel. Default 192. */
  mono: number;
  /** kbps for 2 channels. Default 448. */
  stereo: number;
  /** kbps for 3+ channels (5.0, 5.1, downmixed 7.1). Default 640. */
  surround: number;
}

export interface DeviceProfileDefinition {
  audio: {
    /**
     * ffprobe codec names the device decodes. A trailing "*" is a prefix wildcard ("pcm_*").
     * Default Samsung Tizen: ["ac3", "aac", "mp3"].
     */
    allowedCodecs: string[];
    targetCodec: TargetAudioCodec;
    bitrates: AudioBitrates;
    /** Channel ceiling of the target; sources above it are downmixed (7.1 -> 5.1). */
    maxChannels: number;
  };
  video: {
    /**
     * ffprobe codec names the device decodes. Video outside this list makes the plan "blocked" (never re-encoded in v1;
     * the opt-in VC-1/MPEG-2 -> H.264 re-encode rule is v1.1).
     */
    allowedCodecs: string[];
    dolbyVision: DolbyVisionMode;
  };
  subtitles: {
    /** ffprobe codec names the device renders without burn-in. Informational in v1 (OCR is v1.1). */
    allowedCodecs: string[];
  };
  container: 'mkv';
}

export interface DeviceProfile {
  id: number;
  name: string;
  description: string;
  /** Increments on every edit; part of each media file's rules key so edits re-check only affected files. */
  version: number;
  definition: DeviceProfileDefinition;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * How one assigned profile handles a file on its own: the plan action for that profile alone (skip = plays as is) and
 * the source stream indexes it cannot decode. A failing stream does not mean the file fails: a compatible track of the
 * same programme may cover it.
 */
export interface ProfileResult {
  profileId: number;
  action: PlanAction;
  failingCodecs: string[];
  failingStreams: number[];
}

/** The single profile the rules engine applies: the strictest combination of every profile assigned to a library. */
export interface EffectiveProfile {
  profileIds: number[];
  /** Stable key, e.g. "1@3+4@1" (profile id @ version), stored on media files for change detection. */
  versionKey: string;
  definition: DeviceProfileDefinition;
}

export interface LibraryRuleSettings {
  mode: LibraryMode;
  /** Keep audio and subtitle tracks only in these languages (plus original language). Empty = keep all. */
  keepLanguages: Iso639_2[];
  keepOriginalLanguage: boolean;
  /** Keep tracks with no language tag when filtering. */
  keepUndetermined: boolean;
  /**
   * Tag untagged audio/subtitle tracks: "off", "original" (the item's original language, skipped when unknown) or a
   * fixed ISO 639-2/B code. Applied before the keep-list filter; retagged streams carry PlannedStream.retagged.
   */
  fillMissingLanguage: FillMissingLanguage;
}

export type FillMissingLanguage = 'off' | 'original' | (string & {});

export interface Library extends LibraryRuleSettings {
  id: number;
  name: string;
  kind: LibraryKind;
  enabled: boolean;
  roots: LibraryRoot[];
  profileIds: number[];
  /** Radarr/Sonarr instance that owns this library (for rescans and original language). */
  arrInstanceId: number | null;
  bdmvEnabled: boolean;
  /** Index only disc folders and .iso images, never plain files (a seeding download folder). Needs bdmvEnabled. */
  discsOnly: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface LibraryRoot {
  id: number;
  path: string;
  /** Free space on the root's filesystem, filled by list/get endpoints, null when the path is unreachable. */
  freeBytes: number | null;
  accessible: boolean;
  /** Wololo can create files in it (needed to replace files once processing is on). */
  writable: boolean;
}

export type StreamOp = 'copy' | 'encode';

export interface AudioEncodeSpec {
  codec: TargetAudioCodec;
  bitrateKbps: number;
  channels: number;
  /**
   * Output layout: the source layout when channels are kept, else "5.1" / "stereo" / "mono" for the downmix target.
   * ffmpeg's ac3/eac3 encoders label 6 channels "5.1(side)" and 5 channels "5.0(side)" in the written file, so never
   * compare this string with an output probe literally.
   */
  channelLayout: string;
  downmixed: boolean;
}

export interface PlannedStream {
  sourceIndex: number;
  kind: StreamKind;
  op: StreamOp;
  codec: string;
  encode: AudioEncodeSpec | null;
  language: Iso639_2 | null;
  /** The language tag was filled in by LibraryRuleSettings.fillMissingLanguage (the source track was untagged). */
  retagged: boolean;
  title: string | null;
  default: boolean;
  forced: boolean;
}

export interface DroppedStream {
  sourceIndex: number;
  kind: StreamKind;
  codec: string;
  language: Iso639_2 | null;
  /**
   * incompatible_replaced: Replace mode, the source track was encoded in place (its encoded copy is in streams with the
   * same sourceIndex). compatible_duplicate: an incompatible track dropped because a compatible track in the same
   * language with >= target channels exists. language_filter: keep-list. unsupported: data streams Matroska cannot hold
   * (dropped only when the file is written anyway; never a reason to write).
   */
  reason: 'incompatible_replaced' | 'compatible_duplicate' | 'language_filter' | 'unsupported';
}

/**
 * skip: file already matches the profile, nothing is written.
 * remux: only drops, reorders or flag changes; no encoding.
 * convert: at least one stream is encoded.
 * blocked: work is needed but cannot be done automatically (e.g. video codec unsupported and re-encode disabled).
 */
export type PlanAction = 'skip' | 'remux' | 'convert' | 'blocked';

export interface ConversionPlan {
  action: PlanAction;
  /** Human readable reasons, e.g. "dts (eng, 5.1) not decoded by profile". */
  reasons: string[];
  /** Codecs that failed the profile, used for dry-run grouping and library filters. */
  failingCodecs: string[];
  /**
   * Output streams in output order. In keep_both mode a converted source appears twice (encode first, copy after) and
   * the default converted track leads the audio streams, so the output stream count is streams.length, not probe
   * streams minus dropped. For "blocked", streams/dropped list what would be written if the block were lifted, or
   * are empty when no output can be planned.
   */
  streams: PlannedStream[];
  dropped: DroppedStream[];
  /** Notes recorded in history, e.g. "Atmos height channels dropped", "7.1 downmixed to 5.1". */
  lostFeatures: string[];
  /** Video handling notes for BDMV / Dolby Vision. */
  videoNotes: string[];
  estimatedOutputBytes: number | null;
  rulesKey: string;
}

export const JOB_TYPES = ['audio', 'bdmv'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const ACTIVE_JOB_STATES = ['queued', 'running'] as const satisfies readonly JobState[];
export type ActiveJobState = (typeof ACTIVE_JOB_STATES)[number];

export function isActiveJobState(state: JobState): state is ActiveJobState {
  return (ACTIVE_JOB_STATES as readonly JobState[]).includes(state);
}

export const JOB_STEPS = [
  'waiting',
  'preparing',
  'encoding',
  'muxing',
  'verifying',
  'replacing',
  'importing',
  'notifying',
  'done',
] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export type JobTrigger = 'webhook' | 'scan' | 'manual' | 'retry' | 'recovery';

export interface JobSummary {
  id: number;
  type: JobType;
  state: JobState;
  step: JobStep;
  priority: number;
  trigger: JobTrigger;
  mediaFileId: number | null;
  libraryId: number | null;
  /** The profile an audio job converts for alone; null = the strictest combination of the library's profiles. */
  profileId: number | null;
  sourcePath: string;
  outputPath: string | null;
  title: string;
  /** 0..1 */
  progress: number;
  /** Multiple of real time reported by ffmpeg ("7.7x" -> 7.7). */
  speed: number | null;
  etaSec: number | null;
  error: string | null;
  attempts: number;
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
}

export interface JobDetail extends JobSummary {
  plan: ConversionPlan | null;
  bdmvPlan: BdmvJobPlan | null;
  before: MediaStream[] | null;
  after: MediaStream[] | null;
  lostFeatures: string[];
  verification: VerificationResult | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  hasLog: boolean;
  recycleBinEntryId: number | null;
}

export interface VerificationCheck {
  name:
    | 'duration'
    | 'stream_count'
    | 'video_checksum'
    | 'video_packets'
    | 'audio_decode'
    | 'chapters'
    | 'languages'
    | 'free_space'
    | 'output_exists'
    | 'output_readable';
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export const HISTORY_EVENT_TYPES = [
  'queued',
  'started',
  'completed',
  'failed',
  'cancelled',
  'retried',
  'skipped',
  'recycled',
  'restored',
  'purged',
  'imported',
  'source_deleted',
] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

/** Structured payload of a history row. Writers (jobs, bdmv, integrations) and the web UI share these keys. */
export interface HistoryData {
  lostFeatures?: string[];
  bytesBefore?: number;
  bytesAfter?: number;
  outputPath?: string;
  error?: string;
  recycleBinEntryId?: number;
  /** Streams whose language tag was filled in (PlannedStream.retagged), e.g. "audio 1 -> spa". */
  retagged?: string[];
  arrInstanceId?: number;
  torrentHash?: string;
}

export interface HistoryEntry {
  id: number;
  jobId: number | null;
  mediaFileId: number | null;
  event: HistoryEventType;
  path: string;
  message: string;
  data: HistoryData | null;
  createdAt: IsoDateTime;
}

/**
 * user: POST /queue/pause (persisted as settings.processing.paused). dry_run: settings.processing.enabled is false.
 * low_disk_space: a job found too little free space; the queue holds for 15 minutes or until settings change.
 */
export const QUEUE_PAUSE_REASONS = [
  'user',
  'dry_run',
  'window',
  'plex_streaming',
  'low_disk_space',
  'shutdown',
] as const;
export type QueuePauseReason = (typeof QUEUE_PAUSE_REASONS)[number];

export interface QueueState {
  paused: boolean;
  pauseReasons: QueuePauseReason[];
  running: number;
  queued: number;
  concurrency: number;
}

export interface RecycleBinEntry {
  id: number;
  originalPath: string;
  recyclePath: string;
  sizeBytes: number;
  jobId: number | null;
  mediaFileId: number | null;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  restoredAt: IsoDateTime | null;
  purgedAt: IsoDateTime | null;
}

export const ARR_KINDS = ['radarr', 'sonarr'] as const;
export type ArrKind = (typeof ARR_KINDS)[number];

export interface ArrInstance {
  id: number;
  kind: ArrKind;
  name: string;
  url: string;
  /** Masked ("********") in API responses unless the request explicitly needs it. */
  apiKey: string;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Points at the Radarr movie or Sonarr series a file belongs to. */
export interface ArrItemRef {
  instanceId: number;
  kind: ArrKind;
  /** Radarr movieId or Sonarr seriesId. */
  itemId: number;
  /** Radarr movieFileId or Sonarr episodeFileId, when known. */
  fileId: number | null;
}

export const PATH_MAPPING_SCOPES = ['radarr', 'sonarr', 'plex', 'qbittorrent'] as const;
export type PathMappingScope = (typeof PATH_MAPPING_SCOPES)[number];

export interface PathMapping {
  id: number;
  scope: PathMappingScope;
  /** Restrict to one arr instance; null applies to every instance of the scope. */
  instanceId: number | null;
  /** Path as the remote app sees it, e.g. "/vault/media". */
  remotePath: string;
  /** Path inside the Wololo container, e.g. "/data/media". */
  localPath: string;
}

export interface PlexConnection {
  signedIn: boolean;
  username: string | null;
  serverName: string | null;
  serverMachineId: string | null;
  serverUrl: string | null;
  enabled: boolean;
  /** The only switch for Plex partial scans after a change (read by plex.refreshPath). */
  partialScan: boolean;
  /** The only switch for the queue's Plex auto-pause (read by the jobs worker). */
  pauseWhileStreaming: boolean;
}

export interface PlexServer {
  machineId: string;
  name: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

export interface PlexSection {
  key: string;
  title: string;
  type: 'movie' | 'show' | 'artist' | 'photo';
  locations: string[];
}

export interface DownloadClientConnection {
  kind: 'qbittorrent';
  enabled: boolean;
  url: string;
  username: string;
  /** Masked in API responses. */
  password: string;
  /** Remove torrent + files once the seeding goal is met and the media file was replaced. */
  removeWhenGoalMet: boolean;
  category: string | null;
}

/** savePath and contentPath are local container paths: qbittorrent path mappings are already applied. */
export interface TorrentInfo {
  hash: string;
  name: string;
  savePath: string;
  contentPath: string;
  state: string;
  seeding: boolean;
  ratio: number;
  seedingTimeSec: number;
  ratioLimit: number | null;
  seedingTimeLimitSec: number | null;
  goalMet: boolean;
}

/**
 * main_title: several playlists within ambiguityPercent of the longest.
 * movie_match: Radarr lookup score below minMatchScore (or no result).
 * delete_source: a converted disc's torrent met its seeding goal and settings.bdmv.deleteSourceWhenSeeded is on.
 */
export type BdmvDecisionKind = 'main_title' | 'movie_match' | 'delete_source';
export const BDMV_DECISION_STATES = ['pending', 'resolved', 'dismissed'] as const;
export type BdmvDecisionState = (typeof BDMV_DECISION_STATES)[number];

export interface BdmvTitleCandidate {
  playlist: string;
  durationSec: number;
  clips: string[];
  chapterCount: number;
  audioLanguages: Iso639_2[];
  subtitleLanguages: Iso639_2[];
}

export interface MovieMatchCandidate {
  title: string;
  year: number | null;
  tmdbId: number;
  imdbId: string | null;
  /** 0..1 */
  score: number;
  radarrMovieId: number | null;
}

export type BdmvDecisionChoice =
  | {
      kind: 'main_title';
      playlists: string[];
      asEditions: boolean;
      editionNames: Record<string, string>;
    }
  /** tmdbId from movieCandidates or from a manual search (GET /api/v1/arr/:id/lookup). */
  | { kind: 'movie_match'; tmdbId: number }
  | { kind: 'delete_source'; confirm: boolean };

export interface BdmvDecision {
  id: number;
  mediaFileId: number;
  kind: BdmvDecisionKind;
  state: BdmvDecisionState;
  sourcePath: string;
  message: string;
  titleCandidates: BdmvTitleCandidate[];
  movieCandidates: MovieMatchCandidate[];
  choice: BdmvDecisionChoice | null;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export interface BdmvOutputTitle {
  playlist: string;
  /** Absolute output path: "<radarr root>/Title (Year)/Title (Year) {edition-Extended}.mkv" or ".../Featurettes/<name>.mkv". */
  outputPath: string;
  role: 'main' | 'edition' | 'extra';
  edition: string | null;
}

export interface BdmvJobPlan {
  sourcePath: string;
  sourceKind: 'bdmv' | 'iso';
  movie: MovieMatchCandidate;
  /** Radarr instance that identifies and imports the movie (library's arrInstanceId, else arr.defaultRadarr()). */
  radarrInstanceId: number;
  /**
   * Local path of the Radarr root folder the output is written to: settings.bdmv.rootFolderPath when set, else the
   * Radarr root folder containing the library root of the disc, else the first accessible one.
   */
  rootFolderPath: string;
  titles: BdmvOutputTitle[];
  /** Plan of the main title's audio, computed by rules.plan from a bluray: probe of its playlist. */
  audioPlan: ConversionPlan | null;
  dolbyVision: DolbyVisionMode;
  /** Sum over the titles; a clip shared by two titles counts for each (every title is muxed into its own file). */
  estimatedOutputBytes: number;
  /**
   * Bytes extracted from an .iso before muxing (playlist clips, summed over the titles like estimatedOutputBytes), 0 for
   * folders. Free space needed: extract + output.
   */
  extractBytes: number;
}

export type TaskName =
  | 'library_scan'
  | 'recycle_bin_purge'
  | 'seeding_check'
  | 'backup'
  | 'housekeeping'
  | 'log_cleanup';

export interface ScheduledTaskInfo {
  name: TaskName;
  label: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: IsoDateTime | null;
  lastDurationMs: number | null;
  lastResult: 'success' | 'failure' | null;
  lastMessage: string | null;
  nextRunAt: IsoDateTime | null;
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  id: number;
  time: IsoDateTime;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}
