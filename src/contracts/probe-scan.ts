/**
 * Contract: probe-scan module (src/modules/probe, src/modules/scan, src/modules/scheduler).
 * Owns writes to: libraries, library_roots, library_profiles, media_files, scheduled_tasks.
 */
import type {
  DryRunReport,
  FilesystemListing,
  FilesystemQuery,
  LibraryInput,
  MediaFileDetail,
  MediaFileSummary,
  MediaQuery,
  MediaStats,
  Paginated,
  ScanRequest,
  ScanStatus,
} from '../shared/api-types.ts';
import type {
  ArrItemRef,
  ConversionPlan,
  JobTrigger,
  Library,
  MediaFileKind,
  MediaFileStatus,
  ProbeResult,
  ScheduledTaskInfo,
  TaskName,
} from '../shared/domain.ts';

// ---------- probe ----------

export interface ProbeOptions {
  signal?: AbortSignal;
  /** Also count chapters and read format tags (default true). */
  withChapters?: boolean;
  /**
   * Probe one playlist of a disc instead of a file: path is the disc folder or .iso and ffprobe runs
   * `-playlist <n> bluray:<path>` (n = "00800.mpls" -> 800). Streams then carry their PID in streamId.
   */
  playlist?: string;
}

export interface ProbeService {
  /** Runs `ffprobe -v error -show_streams -show_format -show_chapters -of json` and maps the output. Throws AppError('upstream') on ffprobe failure. */
  probe(path: string, options?: ProbeOptions): Promise<ProbeResult>;
}

/**
 * Pure: raw ffprobe JSON (already parsed) -> typed model. Table-tested against captured fixture output.
 * Languages go through normalizeLanguage; `id` ("0x1100") becomes streamId, `start_time` becomes startTimeSec.
 */
export type ParseFfprobeOutput = (raw: unknown, path: string, sizeBytes: number, probedAt: string) => ProbeResult;

// ---------- libraries ----------

export interface LibraryService {
  list(): Promise<Library[]>;
  get(id: number): Promise<Library>;
  create(input: LibraryInput): Promise<Library>;
  update(id: number, input: LibraryInput): Promise<Library>;
  /**
   * Removes the library and its media_files rows; never touches files on disk. Queued jobs of the library are cancelled
   * through jobs.cancel first; a running job makes it AppError('conflict').
   */
  remove(id: number): Promise<void>;
  /**
   * Longest-prefix match of an absolute local path against all library roots. Compares path.posix.normalize'd absolute
   * paths on segment boundaries; a path with ".." segments is never inside a root.
   */
  findRootForPath(path: string): Promise<{ library: Library; rootId: number; rootPath: string } | null>;
  browse(query: FilesystemQuery): Promise<FilesystemListing>;
}

// ---------- media files ----------

export interface MediaRefs {
  trigger: JobTrigger;
  arr?: ArrItemRef | null;
  /** ISO 639-2/B original language from Radarr/Sonarr (already normalised), when known. */
  originalLanguage?: string | null;
}

export type CheckAction =
  | 'compatible'
  | 'queued'
  | 'dry_run'
  | 'blocked'
  | 'ignored'
  | 'failed'
  | 'unknown_path'
  | 'decision_required';

export interface CheckResult {
  action: CheckAction;
  mediaFile: MediaFileSummary | null;
  jobId: number | null;
  message: string;
}

export interface JobResultUpdate {
  status: MediaFileStatus;
  reason: string | null;
  lastJobId: number;
  /**
   * New path when an audio job changed the container (e.g. .mp4 -> .mkv). Never set by BDMV jobs: the disc row keeps
   * its path and records status "compatible" with reason "converted to <output>".
   */
  path?: string;
  /** Fresh probe of the written file; recomputes the plan and rules key when given. */
  probe?: ProbeResult | null;
}

export interface MediaService {
  list(query: MediaQuery): Promise<Paginated<MediaFileSummary>>;
  get(id: number): Promise<MediaFileDetail>;
  stats(libraryId?: number): Promise<MediaStats>;
  findByPath(path: string): Promise<MediaFileSummary | null>;
  /**
   * Single entry point used by webhooks and the scanner for one path:
   * libraries.findRootForPath (none -> "unknown_path") -> upsert row (kind file|bdmv|iso, size, mtime)
   * -> resolve arr + originalLanguage: refs when given, else the values cached on the row, else arr.findByPath(path)
   *    (cached in media_files.arr_* / original_language; failures logged, never fatal)
   * -> kind bdmv|iso: bdmv.evaluate(row.id) and map BdmvEvaluation to status/plan/decision
   *    (needs_work + plan -> enqueue a "bdmv" job with NewJob.bdmvPlan; needs_work + no plan + decisionId ->
   *    "decision_required", not queued);
   *    else probe -> rules.effectiveProfileForLibrary -> rules.plan
   * -> status: plan action skip -> compatible, remux|convert -> needs_work, blocked -> blocked (CheckAction "blocked",
   *    statusReason "blocked: <reasons>"); ignored rows keep "ignored"
   * -> processing.enabled && needs_work ? jobs.enqueue : "dry_run".
   * Paths the scanner would skip (temp files, the recycle bin, ignore patterns) are not indexed here either.
   * Never throws for per-file problems; reports them in CheckResult.
   */
  checkPath(path: string, refs: MediaRefs): Promise<CheckResult>;
  /** Re-probe + re-evaluate an existing row (POST /media/:id/probe). Keeps status "ignored". */
  reprobe(id: number): Promise<MediaFileDetail>;
  /** Current plan with current profiles, without persisting (GET /media/:id/plan). */
  previewPlan(id: number): Promise<ConversionPlan>;
  /** reason is stored as statusReason (e.g. "restored from recycle bin"); un-ignoring re-evaluates the row. */
  setIgnored(id: number, ignored: boolean, reason?: string | null): Promise<MediaFileSummary>;
  /** Used by the jobs module: mark processing / record the outcome of a job. */
  setStatus(id: number, status: MediaFileStatus, reason: string | null): Promise<void>;
  recordJobResult(id: number, update: JobResultUpdate): Promise<void>;
  /** Mark rows whose rulesKey no longer matches (after a profile or library edit) as pending re-check. */
  invalidateRules(filter: { libraryId?: number; profileId?: number }): Promise<number>;
}

// ---------- scanner ----------

/**
 * Scan of every enabled library root: new/changed entries (needsRecheck) go through media.checkPath; rows whose path no
 * longer exists are deleted (media.removed). When processing is enabled, unchanged rows with status needs_work and no
 * queued/running job are enqueued without a re-probe, so the backlog found in dry-run mode starts after opt-in.
 */
export interface ScanService {
  /** Starts a scan in the background (one at a time); returns the running scan if one is active. */
  start(request: ScanRequest): Promise<ScanStatus>;
  current(): ScanStatus | null;
  cancel(): Promise<void>;
}

export interface DiscoveredEntry {
  path: string;
  kind: MediaFileKind;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Pure: should this entry be (re)probed? Compares path+size+mtime+rulesKey against the stored row. Ignored rows: only
 * when force. Rows with status "processing" are treated like "ignored" (a running job owns the file).
 */
export type NeedsRecheck = (
  entry: DiscoveredEntry,
  stored: {
    sizeBytes: number;
    mtimeMs: number;
    rulesKey: string | null;
    status: MediaFileStatus;
  } | null,
  currentRulesKey: string,
  force: boolean,
) => boolean;

/**
 * Pure: classifies a directory entry. childNames are the folder's entries plus "BDMV/<name>" for each entry of a BDMV
 * subfolder; a disc root is recognised by "BDMV/index.bdmv" (case-insensitive). Files: ".iso" -> iso, anything else ->
 * file (the scanner filters extensions first). A folder named BDMV itself -> null.
 */
export type ClassifyEntry = (path: string, isDirectory: boolean, childNames: string[]) => MediaFileKind | null;

// ---------- dry run ----------

export interface DryRunService {
  /**
   * Aggregates probed media_files rows; reads only, writes nothing. byProfile re-runs rules.plan per assigned profile
   * on the stored probe JSON (paged, no ffprobe).
   */
  report(options: { libraryId?: number; profileId?: number }): Promise<DryRunReport>;
}

// ---------- scheduler ----------

export interface TaskDefinition {
  name: TaskName;
  label: string;
  defaultIntervalMinutes: number;
  run: (signal: AbortSignal) => Promise<string | undefined>;
}

export interface SchedulerService {
  list(): Promise<ScheduledTaskInfo[]>;
  runNow(name: TaskName): Promise<ScheduledTaskInfo>;
  update(name: TaskName, patch: { intervalMinutes?: number; enabled?: boolean }): Promise<ScheduledTaskInfo>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Default task table. Handlers call other modules only through ctx.services. */
export const DEFAULT_TASK_INTERVALS: Readonly<Record<TaskName, number>> = {
  library_scan: 360,
  recycle_bin_purge: 60,
  seeding_check: 30,
  backup: 10080,
  housekeeping: 1440,
  log_cleanup: 1440,
};
