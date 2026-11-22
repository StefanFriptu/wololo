/**
 * REST API contract shared by the backend route handlers and the web client.
 * Every key of ApiRoutes is "<METHOD> <path>" with Hono-style ":param" segments, without the configurable URL base.
 * API_ROUTE_META (src/shared/api-routes.ts) lists the same keys with owner module, auth and response type.
 */
import type {
  ArrInstance,
  ArrKind,
  BdmvDecision,
  BdmvDecisionChoice,
  BdmvDecisionState,
  BdmvTitleCandidate,
  ConversionPlan,
  DeviceProfile,
  DeviceProfileDefinition,
  DownloadClientConnection,
  FillMissingLanguage,
  HistoryEntry,
  HistoryEventType,
  IsoDateTime,
  JobDetail,
  JobSummary,
  JobType,
  Library,
  LibraryKind,
  LibraryMode,
  LogEntry,
  LogLevel,
  MediaFileKind,
  MediaFileStatus,
  MovieMatchCandidate,
  PathMapping,
  PathMappingScope,
  PlanAction,
  PlexConnection,
  PlexSection,
  PlexServer,
  ProbeResult,
  ProfileResult,
  QueueState,
  RecycleBinEntry,
  ScheduledTaskInfo,
  SortDir,
  TaskName,
} from './domain.ts';
import type { ScanStats } from './events.ts';
import type { DeepPartial, GeneralConfig, Settings } from './settings.ts';

export interface ApiErrorBody {
  /** Stable machine code: "not_found", "validation", "unprocessable", "conflict", "unauthorized", "precondition_failed", "upstream", "internal". */
  error: string;
  message: string;
  details?: unknown;
}

/** Successful write with nothing to return: HTTP 204, no body. */
export type NoContent = undefined;

export interface PageQuery {
  /** 1-based. Default 1. */
  page?: number;
  /** Default 50, max 500. */
  pageSize?: number;
  sortDir?: SortDir;
}

export interface Paginated<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export interface IdParams {
  id: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  version: string | null;
}

// ---------- system / platform ----------

export interface HealthResponse {
  status: 'ok';
  version: string;
}

export interface ToolInfo {
  /** "7z" lists and extracts Blu-ray .iso images (UDF 2.50) for BDMV jobs. */
  name: 'ffmpeg' | 'ffprobe' | 'mkvmerge' | '7z' | 'nice' | 'ionice';
  path: string | null;
  version: string | null;
  available: boolean;
}

export interface SystemStatus {
  appName: 'Wololo';
  version: string;
  instanceName: string;
  startTime: IsoDateTime;
  uptimeSec: number;
  runtime: string;
  os: string;
  arch: string;
  isDocker: boolean;
  configDir: string;
  databasePath: string;
  databaseSizeBytes: number;
  memoryRssBytes: number;
  urlBase: string;
  tools: ToolInfo[];
}

export interface HealthCheck {
  source: string;
  level: 'notice' | 'warning' | 'error';
  message: string;
}

export interface TaskUpdate {
  intervalMinutes?: number;
  enabled?: boolean;
}

export interface LogQuery {
  level?: LogLevel;
  module?: string;
  /** Only entries with id greater than this (for polling). */
  afterId?: number;
  /** Default 200, max 1000 (ring buffer size). */
  limit?: number;
}

export interface LogFileInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: IsoDateTime;
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: IsoDateTime;
  kind: 'manual' | 'scheduled' | 'pre_restore';
}

export interface RestoreResult {
  restartRequired: boolean;
}

// ---------- settings ----------

export type SettingsUpdate = DeepPartial<Settings>;

export interface GeneralConfigView extends GeneralConfig {
  restartRequired: boolean;
  /** Port the server listens on until the next restart; `port` is the saved value it uses after one. */
  runningPort: number;
  /** Fields pinned by WOLOLO__* environment variables; PUT answers 409 for them. */
  envOverrides: (keyof GeneralConfig)[];
  /** In the image the port and bind address must stay 8585 and "*" unless compose publishes otherwise. */
  isDocker: boolean;
}

export type GeneralConfigUpdate = Partial<Omit<GeneralConfig, 'apiKey'>>;

// ---------- libraries / media / scan / dry run ----------

export interface LibraryInput {
  name: string;
  kind: LibraryKind;
  enabled?: boolean;
  roots: string[];
  profileIds: number[];
  mode?: LibraryMode;
  keepLanguages?: string[];
  keepOriginalLanguage?: boolean;
  keepUndetermined?: boolean;
  /** Default "off". */
  fillMissingLanguage?: FillMissingLanguage;
  arrInstanceId?: number | null;
  bdmvEnabled?: boolean;
  /** Default false; true needs bdmvEnabled. */
  discsOnly?: boolean;
}

export interface FilesystemQuery {
  path?: string;
  includeFiles?: boolean;
}

export interface FilesystemEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  sizeBytes: number | null;
}

export interface FilesystemListing {
  path: string;
  parent: string | null;
  entries: FilesystemEntry[];
}

export type MediaSortKey = 'path' | 'size' | 'status' | 'updatedAt' | 'duration';

export interface MediaQuery extends PageQuery {
  sortKey?: MediaSortKey;
  /** One status or a comma separated list. */
  status?: string;
  libraryId?: number;
  profileId?: number;
  /** Matches any stream codec (ffprobe name). */
  codec?: string;
  /** Matches failing codecs only. */
  failingCodec?: string;
  /** One kind or a comma separated list. */
  kind?: string;
  /** Case-insensitive substring of the path. */
  search?: string;
}

export interface MediaFileSummary {
  id: number;
  libraryId: number;
  path: string;
  relativePath: string;
  kind: MediaFileKind;
  sizeBytes: number;
  durationSec: number | null;
  status: MediaFileStatus;
  statusReason: string | null;
  videoCodec: string | null;
  audioCodecs: string[];
  subtitleLanguages: string[];
  failingCodecs: string[];
  planAction: PlanAction | null;
  /** One entry per profile assigned to the library; null for discs and files not evaluated since profiles changed. */
  profileResults: ProfileResult[] | null;
  lastJobId: number | null;
  probedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
}

export interface MediaFileDetail extends MediaFileSummary {
  probe: ProbeResult | null;
  plan: ConversionPlan | null;
  rulesKey: string | null;
  originalLanguage: string | null;
  arr: {
    instanceId: number;
    kind: ArrKind;
    itemId: number;
    fileId: number | null;
  } | null;
  jobs: JobSummary[];
}

export interface MediaIgnoreBody {
  ignored: boolean;
}

export interface MediaStats {
  total: number;
  totalBytes: number;
  byStatus: Record<MediaFileStatus, number>;
  byFailingCodec: { codec: string; count: number }[];
}

export interface ScanRequest {
  libraryId?: number;
  /** Re-probe every file, ignoring the size+mtime+rulesKey change detection. */
  force?: boolean;
}

export interface ScanStatus {
  scanId: string;
  libraryId: number | null;
  running: boolean;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  currentPath: string | null;
  stats: ScanStats;
  error: string | null;
}

export interface DryRunQuery {
  libraryId?: number;
  /** Restrict byProfile to one profile. */
  profileId?: number;
}

/**
 * Files evaluated against one assigned profile on its own (rules.plan re-run on the stored probe JSON, no ffprobe).
 * groups/totals use the library's effective (strictest) profile, which is what jobs actually apply.
 */
export interface DryRunProfileRow {
  profileId: number;
  name: string;
  files: number;
  failing: number;
  durationSec: number;
  estimatedSeconds: number;
  estimatedOutputBytes: number;
}

export interface DryRunGroup {
  /** Failing codec (ffprobe name) or "video:<codec>" / "bdmv" for non-audio work. */
  codec: string;
  files: number;
  durationSec: number;
  sizeBytes: number;
  estimatedSeconds: number;
  estimatedOutputBytes: number;
  samplePaths: string[];
}

export interface DryRunReport {
  generatedAt: IsoDateTime;
  libraryId: number | null;
  processingEnabled: boolean;
  totals: {
    files: number;
    compatible: number;
    needsWork: number;
    blocked: number;
    failed: number;
    pending: number;
    ignored: number;
  };
  groups: DryRunGroup[];
  byProfile: DryRunProfileRow[];
  estimatedSeconds: number;
  /** Peak extra disk space: largest output + 5% margin per root, plus recycle-bin copies kept for the retention period. */
  estimatedExtraBytes: number;
  estimatedRecycleBytes: number;
}

// ---------- profiles ----------

export interface ProfileInput {
  name: string;
  description?: string;
  definition: DeviceProfileDefinition;
}

export interface ProfileCloneBody {
  name: string;
}

export interface CodecInfo {
  codec: string;
  label: string;
  kind: 'audio' | 'video' | 'subtitle';
  lossless: boolean;
}

export interface CodecCatalog {
  audio: CodecInfo[];
  video: CodecInfo[];
  subtitle: CodecInfo[];
}

export interface ProfileWithUsage extends DeviceProfile {
  libraryIds: number[];
}

export const PROFILE_TEMPLATE_IDS = ['basic', 'dolby', 'lossless', 'everything', 'blank'] as const;
export type ProfileTemplateId = (typeof PROFILE_TEMPLATE_IDS)[number];

/** A starting point for a new profile, named after the formats it plays, never after a device. */
export interface ProfileTemplate {
  id: ProfileTemplateId;
  name: string;
  description: string;
  definition: DeviceProfileDefinition;
}

// ---------- jobs / queue / history / recycle bin ----------

export interface QueueResponse {
  state: QueueState;
  items: JobSummary[];
}

export interface JobQuery extends PageQuery {
  /** One state or a comma separated list. */
  state?: string;
  type?: JobType;
  mediaFileId?: number;
}

/**
 * Exactly one of mediaFileIds or filter. A filter is expanded server-side through media.list in pages, so
 * "Process all needs-work" after the dry run works on a whole library without sending ids.
 */
export interface EnqueueRequest {
  mediaFileIds?: number[];
  filter?: EnqueueFilter;
  priority?: number;
  /** Queue even when the file was evaluated as compatible (re-run rules). */
  force?: boolean;
  /** Convert for this assigned profile alone; omitted = the strictest combination of the library's profiles. */
  profileId?: number;
}

/** Same meaning as the MediaQuery fields of the same name, so a bulk action queues exactly what the list shows. */
export interface EnqueueFilter {
  libraryId?: number;
  /** Default "needs_work". */
  status?: MediaFileStatus;
  failingCodec?: string;
  /** One kind or a comma separated list. */
  kind?: string;
  profileId?: number;
  search?: string;
  codec?: string;
}

export interface EnqueueResponse {
  jobs: JobSummary[];
  skipped: { mediaFileId: number; reason: string }[];
}

export interface JobLogTailQuery {
  /** Byte offset to continue from (the `end` of the previous chunk); omitted starts at the tail of the log. */
  from?: number;
}

/** Whole lines of a job log; `start` and `end` are byte offsets, `size` is the file size when it was read. */
export interface JobLogChunk {
  text: string;
  start: number;
  end: number;
  size: number;
}

export interface HistoryQuery extends PageQuery {
  event?: HistoryEventType;
  mediaFileId?: number;
  jobId?: number;
}

export interface RecycleBinPurgeRequest {
  /** true = purge everything, false/omitted = only expired entries. */
  all?: boolean;
}

export interface RecycleBinPurgeResult {
  purged: number;
  freedBytes: number;
}

// ---------- integrations ----------

export interface ArrInstanceInput {
  kind: ArrKind;
  name: string;
  url: string;
  /**
   * Send "********" to keep the stored key on update/test. The mask resolves only when url is the stored URL (scheme,
   * host, port and path; trailing slashes ignored); with another URL it is 422 on create/update and ok: false on test.
   */
  apiKey: string;
  enabled?: boolean;
}

export interface ArrTestRequest extends ArrInstanceInput {
  /** Existing instance id, so a masked apiKey can be resolved. */
  id?: number;
}

export interface ArrRootFolder {
  id: number;
  /** Path as Radarr/Sonarr reports it. */
  path: string;
  /** Mapped local path (unchanged when no mapping matches); accessible says whether it exists in the container. */
  localPath: string;
  accessible: boolean;
  freeBytes: number | null;
}

/** Wololo's webhook in Radarr/Sonarr Settings > Connect. */
export interface ArrWebhookStatus {
  configured: boolean;
  /** Webhook URL with the API key masked; null when not configured. */
  url: string | null;
  /** Sends On Import and On Upgrade. */
  triggersOk: boolean;
}

export interface ArrWebhookRequest {
  /** Wololo's address as Radarr/Sonarr reach it, e.g. "http://wololo:8585" (the URL base is appended). */
  address: string;
}

export interface ArrWebhookTest {
  /** Radarr/Sonarr accepted the test. */
  sent: boolean;
  /** The Test event reached Wololo. */
  received: boolean;
  message: string;
}

/** One real library file of the instance, looked up here through the path mappings. */
export interface ArrPathCheck {
  ok: boolean;
  message: string;
  /** The file as Radarr/Sonarr name it; null when the instance has no file yet. */
  remotePath: string | null;
  localPath: string | null;
  /** A mapping that would make the file visible here, found under a library folder. */
  suggestion: PathMappingInput | null;
}

export interface ArrQualityProfile {
  id: number;
  name: string;
}

/** Manual Radarr search from the BDMV movie_match decision (wraps GET /api/v3/movie/lookup). */
export interface ArrLookupQuery {
  term: string;
  year?: number;
}

/**
 * Webhook URL shown on Settings > Connect: /api/v1/webhook/radarr?instance=<arr instance id>&apikey=<key>.
 * Without instance: the only enabled instance of that kind, else the one whose name equals payload.instanceName,
 * else the one whose url equals payload.applicationUrl; still ambiguous -> action "error".
 */
export interface WebhookQuery {
  instance?: number;
}

/** Subset of Radarr's webhook payload (Settings > Connect > Webhook). Unknown fields are ignored. */
export interface RadarrWebhookPayload {
  eventType: 'Test' | 'Grab' | 'Download' | 'Rename' | 'MovieDelete' | 'MovieFileDelete' | string;
  instanceName?: string;
  applicationUrl?: string;
  isUpgrade?: boolean;
  movie?: {
    id: number;
    title: string;
    year?: number;
    folderPath?: string;
    tmdbId?: number;
    imdbId?: string;
    /** Language name ("English"); convert with normalizeLanguage(name). */
    originalLanguage?: { id: number; name: string };
  };
  movieFile?: {
    id: number;
    relativePath?: string;
    path?: string;
    size?: number;
  };
  downloadClient?: string;
  downloadClientType?: string;
  downloadId?: string;
}

/** Subset of Sonarr's webhook payload. */
export interface SonarrWebhookPayload {
  eventType: 'Test' | 'Grab' | 'Download' | 'Rename' | 'SeriesDelete' | 'EpisodeFileDelete' | string;
  instanceName?: string;
  applicationUrl?: string;
  isUpgrade?: boolean;
  series?: {
    id: number;
    title: string;
    path?: string;
    tvdbId?: number;
    originalLanguage?: { id: number; name: string };
  };
  episodes?: {
    id: number;
    episodeNumber: number;
    seasonNumber: number;
    title?: string;
  }[];
  episodeFile?: {
    id: number;
    relativePath?: string;
    path?: string;
    size?: number;
  };
  episodeFiles?: { id: number; relativePath?: string; path?: string }[];
  downloadClient?: string;
  downloadId?: string;
}

export interface WebhookResponse {
  accepted: boolean;
  action:
    | 'test'
    | 'ignored'
    | 'accepted'
    | 'compatible'
    | 'queued'
    | 'dry_run'
    | 'unknown_path'
    | 'blocked'
    | 'decision_required'
    | 'error';
  mediaFileIds: number[];
  message: string;
}

/**
 * serverMachineId selects a server from plex.tv resources; serverUrl may pick one of the addresses plex.tv lists for it.
 * serverUrl alone keeps the selected server's token only when plex.tv lists that host for it; any other URL uses
 * serverToken when given, else no token (stored tokens never go to a URL the caller chose).
 */
export interface PlexConnectionUpdate {
  serverMachineId?: string;
  serverUrl?: string;
  /** Write-only token for a manual serverUrl that plex.tv does not list (e.g. http://plex:32400). */
  serverToken?: string;
  enabled?: boolean;
  partialScan?: boolean;
  pauseWhileStreaming?: boolean;
}

export interface PlexPin {
  id: number;
  code: string;
  /** https://app.plex.tv/auth#?clientID=...&code=...&context[device][product]=Wololo */
  authUrl: string;
  expiresAt: IsoDateTime;
}

export interface PlexPinStatus {
  authenticated: boolean;
  expired: boolean;
  connection: PlexConnection;
}

export interface PlexSessions {
  active: number;
  sessions: {
    title: string;
    user: string | null;
    state: string;
    transcoding: boolean;
  }[];
}

/**
 * password: send "********" (the masked value from GET) to keep the stored password on save and test. Like
 * ArrInstanceInput.apiKey, the mask resolves only for the stored URL.
 */
export type DownloadClientInput = DownloadClientConnection;

export interface PathMappingInput {
  scope: PathMappingScope;
  instanceId?: number | null;
  remotePath: string;
  localPath: string;
}

// ---------- bdmv ----------

export interface BdmvDecisionQuery {
  state?: BdmvDecisionState;
}

export interface BdmvPlaylistView extends BdmvTitleCandidate {
  duplicateOf: string | null;
  role: 'main' | 'candidate' | 'extra' | 'ignored';
}

export interface BdmvDiscInfo {
  mediaFileId: number;
  path: string;
  kind: 'bdmv' | 'iso';
  encrypted: boolean;
  encryptionMarkers: string[];
  volumeLabel: string | null;
  playlists: BdmvPlaylistView[];
  mainPlaylist: string | null;
  needsDecision: boolean;
  /** "<file>: <error>" for every MPLS that could not be parsed; the main title may be among them. */
  parseErrors: string[];
  /** Non-fatal problems, e.g. a CLPI that could not be parsed for the language fallback. */
  warnings: string[];
}

// ---------- route map ----------

export interface ApiRoutes {
  'GET /health': { response: HealthResponse };
  'GET /api/v1/events': { response: never };

  'GET /api/v1/system/status': { response: SystemStatus };
  'GET /api/v1/system/health': { response: HealthCheck[] };
  'GET /api/v1/system/tasks': { response: ScheduledTaskInfo[] };
  'PUT /api/v1/system/tasks/:name': {
    params: { name: TaskName };
    body: TaskUpdate;
    response: ScheduledTaskInfo;
  };
  'POST /api/v1/system/tasks/:name/run': {
    params: { name: TaskName };
    response: ScheduledTaskInfo;
  };
  'GET /api/v1/system/logs': { query: LogQuery; response: LogEntry[] };
  'GET /api/v1/system/logs/files': { response: LogFileInfo[] };
  'GET /api/v1/system/logs/files/:name': {
    params: { name: string };
    response: string;
  };
  'GET /api/v1/system/backups': { response: BackupInfo[] };
  'POST /api/v1/system/backups': { response: BackupInfo };
  'GET /api/v1/system/backups/:name': {
    params: { name: string };
    response: Blob;
  };
  'DELETE /api/v1/system/backups/:name': {
    params: { name: string };
    response: NoContent;
  };
  'POST /api/v1/system/backups/:name/restore': {
    params: { name: string };
    response: RestoreResult;
  };
  /** multipart/form-data with a "file" field containing a backup zip. */
  'POST /api/v1/system/backups/restore': {
    body: FormData;
    response: RestoreResult;
  };
  'POST /api/v1/system/restart': { response: NoContent };
  'GET /api/v1/openapi.json': { response: Record<string, unknown> };
  'GET /api/v1/docs': { response: string };

  'GET /api/v1/settings': { response: Settings };
  'PUT /api/v1/settings': { body: SettingsUpdate; response: Settings };
  'GET /api/v1/settings/general': { response: GeneralConfigView };
  'PUT /api/v1/settings/general': {
    body: GeneralConfigUpdate;
    response: GeneralConfigView;
  };
  'POST /api/v1/settings/general/apikey': { response: GeneralConfigView };

  'GET /api/v1/libraries': { response: Library[] };
  'POST /api/v1/libraries': { body: LibraryInput; response: Library };
  'GET /api/v1/libraries/:id': { params: IdParams; response: Library };
  'PUT /api/v1/libraries/:id': {
    params: IdParams;
    body: LibraryInput;
    response: Library;
  };
  'DELETE /api/v1/libraries/:id': { params: IdParams; response: NoContent };
  'GET /api/v1/filesystem': {
    query: FilesystemQuery;
    response: FilesystemListing;
  };
  'GET /api/v1/media': {
    query: MediaQuery;
    response: Paginated<MediaFileSummary>;
  };
  'GET /api/v1/media/stats': {
    query: { libraryId?: number };
    response: MediaStats;
  };
  'GET /api/v1/media/:id': { params: IdParams; response: MediaFileDetail };
  'POST /api/v1/media/:id/probe': {
    params: IdParams;
    response: MediaFileDetail;
  };
  'GET /api/v1/media/:id/plan': { params: IdParams; response: ConversionPlan };
  'PUT /api/v1/media/:id/ignore': {
    params: IdParams;
    body: MediaIgnoreBody;
    response: MediaFileSummary;
  };
  'POST /api/v1/scans': { body: ScanRequest; response: ScanStatus };
  'GET /api/v1/scans/current': { response: ScanStatus | null };
  'DELETE /api/v1/scans/current': { response: NoContent };
  'GET /api/v1/dryrun': { query: DryRunQuery; response: DryRunReport };

  'GET /api/v1/profiles': { response: ProfileWithUsage[] };
  'POST /api/v1/profiles': { body: ProfileInput; response: ProfileWithUsage };
  'GET /api/v1/profiles/codecs': { response: CodecCatalog };
  'GET /api/v1/profiles/templates': { response: ProfileTemplate[] };
  'GET /api/v1/profiles/:id': { params: IdParams; response: ProfileWithUsage };
  'PUT /api/v1/profiles/:id': {
    params: IdParams;
    body: ProfileInput;
    response: ProfileWithUsage;
  };
  'DELETE /api/v1/profiles/:id': { params: IdParams; response: NoContent };
  'POST /api/v1/profiles/:id/clone': {
    params: IdParams;
    body: ProfileCloneBody;
    response: ProfileWithUsage;
  };

  'GET /api/v1/queue': { response: QueueResponse };
  'POST /api/v1/queue/pause': { response: QueueState };
  'POST /api/v1/queue/resume': { response: QueueState };
  'GET /api/v1/jobs': { query: JobQuery; response: Paginated<JobSummary> };
  'POST /api/v1/jobs': { body: EnqueueRequest; response: EnqueueResponse };
  'GET /api/v1/jobs/:id': { params: IdParams; response: JobDetail };
  'GET /api/v1/jobs/:id/log': { params: IdParams; response: string };
  'GET /api/v1/jobs/:id/log/tail': { params: IdParams; query: JobLogTailQuery; response: JobLogChunk };
  'POST /api/v1/jobs/:id/cancel': { params: IdParams; response: JobSummary };
  'POST /api/v1/jobs/:id/retry': { params: IdParams; response: JobSummary };
  'DELETE /api/v1/jobs/:id': { params: IdParams; response: NoContent };
  'GET /api/v1/history': {
    query: HistoryQuery;
    response: Paginated<HistoryEntry>;
  };
  'GET /api/v1/recyclebin': {
    query: PageQuery;
    response: Paginated<RecycleBinEntry>;
  };
  'POST /api/v1/recyclebin/:id/restore': {
    params: IdParams;
    response: RecycleBinEntry;
  };
  'DELETE /api/v1/recyclebin/:id': { params: IdParams; response: NoContent };
  'POST /api/v1/recyclebin/purge': {
    body: RecycleBinPurgeRequest;
    response: RecycleBinPurgeResult;
  };

  'GET /api/v1/arr': { response: ArrInstance[] };
  'POST /api/v1/arr': { body: ArrInstanceInput; response: ArrInstance };
  'POST /api/v1/arr/test': {
    body: ArrTestRequest;
    response: ConnectionTestResult;
  };
  'GET /api/v1/arr/:id': { params: IdParams; response: ArrInstance };
  'PUT /api/v1/arr/:id': {
    params: IdParams;
    body: ArrInstanceInput;
    response: ArrInstance;
  };
  'DELETE /api/v1/arr/:id': { params: IdParams; response: NoContent };
  'GET /api/v1/arr/:id/rootfolders': {
    params: IdParams;
    response: ArrRootFolder[];
  };
  'GET /api/v1/arr/:id/qualityprofiles': {
    params: IdParams;
    response: ArrQualityProfile[];
  };
  'GET /api/v1/arr/:id/webhook': { params: IdParams; response: ArrWebhookStatus };
  'PUT /api/v1/arr/:id/webhook': {
    params: IdParams;
    body: ArrWebhookRequest;
    response: ArrWebhookStatus;
  };
  'POST /api/v1/arr/:id/webhook/test': { params: IdParams; response: ArrWebhookTest };
  'GET /api/v1/arr/:id/pathcheck': { params: IdParams; response: ArrPathCheck };
  'GET /api/v1/arr/:id/lookup': {
    params: IdParams;
    query: ArrLookupQuery;
    response: MovieMatchCandidate[];
  };
  'POST /api/v1/webhook/radarr': {
    query: WebhookQuery;
    body: RadarrWebhookPayload;
    response: WebhookResponse;
  };
  'POST /api/v1/webhook/sonarr': {
    query: WebhookQuery;
    body: SonarrWebhookPayload;
    response: WebhookResponse;
  };
  'GET /api/v1/plex': { response: PlexConnection };
  'PUT /api/v1/plex': { body: PlexConnectionUpdate; response: PlexConnection };
  'DELETE /api/v1/plex': { response: PlexConnection };
  'POST /api/v1/plex/pin': { response: PlexPin };
  'GET /api/v1/plex/pin/:id': { params: IdParams; response: PlexPinStatus };
  'GET /api/v1/plex/servers': { response: PlexServer[] };
  'GET /api/v1/plex/sections': { response: PlexSection[] };
  'POST /api/v1/plex/test': { response: ConnectionTestResult };
  'GET /api/v1/plex/sessions': { response: PlexSessions };
  'GET /api/v1/downloadclient': { response: DownloadClientConnection | null };
  'PUT /api/v1/downloadclient': {
    body: DownloadClientInput;
    response: DownloadClientConnection;
  };
  'DELETE /api/v1/downloadclient': { response: NoContent };
  'POST /api/v1/downloadclient/test': {
    body: DownloadClientInput;
    response: ConnectionTestResult;
  };
  'GET /api/v1/pathmappings': { response: PathMapping[] };
  'POST /api/v1/pathmappings': {
    body: PathMappingInput;
    response: PathMapping;
  };
  'PUT /api/v1/pathmappings/:id': {
    params: IdParams;
    body: PathMappingInput;
    response: PathMapping;
  };
  'DELETE /api/v1/pathmappings/:id': { params: IdParams; response: NoContent };

  'GET /api/v1/bdmv/decisions': {
    query: BdmvDecisionQuery;
    response: BdmvDecision[];
  };
  'GET /api/v1/bdmv/decisions/:id': {
    params: IdParams;
    response: BdmvDecision;
  };
  'POST /api/v1/bdmv/decisions/:id/resolve': {
    params: IdParams;
    body: BdmvDecisionChoice;
    response: BdmvDecision;
  };
  'POST /api/v1/bdmv/decisions/:id/dismiss': {
    params: IdParams;
    response: BdmvDecision;
  };
  'GET /api/v1/bdmv/discs/:id': { params: IdParams; response: BdmvDiscInfo };
}

export type RouteKey = keyof ApiRoutes;
export type RouteParams<K extends RouteKey> = ApiRoutes[K] extends {
  params: infer P;
}
  ? P
  : undefined;
export type RouteQuery<K extends RouteKey> = ApiRoutes[K] extends {
  query: infer Q;
}
  ? Q
  : undefined;
export type RouteBody<K extends RouteKey> = ApiRoutes[K] extends {
  body: infer B;
}
  ? B
  : undefined;
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]['response'];
