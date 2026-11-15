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
}

export interface ProbeService {
  /** Runs `ffprobe -v error -show_streams -show_format -show_chapters -of json` and maps the output. Throws AppError('upstream') on ffprobe failure. */
  probe(path: string, options?: ProbeOptions): Promise<ProbeResult>;
}

/** Pure: raw ffprobe JSON (already parsed) -> typed model. Table-tested against captured fixture output. */
export type ParseFfprobeOutput = (
  raw: unknown,
  path: string,
  sizeBytes: number,
  probedAt: string,
) => ProbeResult;

// ---------- libraries ----------

export interface LibraryService {
  list(): Promise<Library[]>;
  get(id: number): Promise<Library>;
  create(input: LibraryInput): Promise<Library>;
  update(id: number, input: LibraryInput): Promise<Library>;
  /** Removes the library and its media_files rows; never touches files on disk. */
  remove(id: number): Promise<void>;
  /** Longest-prefix match of an absolute local path against all library roots. */
  findRootForPath(
    path: string,
  ): Promise<{ library: Library; rootId: number; rootPath: string } | null>;
  browse(query: FilesystemQuery): Promise<FilesystemListing>;
}

// ---------- media files ----------

export interface MediaRefs {
  trigger: JobTrigger;
  arr?: ArrItemRef | null;
  /** ISO 639-2 original language from Radarr/Sonarr, when known. */
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
  /** New path when the job changed it (container change, BDMV output). */
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
   * upsert row -> probe (or bdmv.analyze for discs) -> rules -> status -> enqueue when processing is enabled.
   * Never throws for per-file problems; reports them in CheckResult.
   */
  checkPath(path: string, refs: MediaRefs): Promise<CheckResult>;
  /** Re-probe + re-evaluate an existing row (POST /media/:id/probe). */
  reprobe(id: number): Promise<MediaFileDetail>;
  /** Current plan with current profiles, without persisting (GET /media/:id/plan). */
  previewPlan(id: number): Promise<ConversionPlan>;
  setIgnored(id: number, ignored: boolean): Promise<MediaFileSummary>;
  /** Used by the jobs module: mark processing / record the outcome of a job. */
  setStatus(
    id: number,
    status: MediaFileStatus,
    reason: string | null,
  ): Promise<void>;
  recordJobResult(id: number, update: JobResultUpdate): Promise<void>;
  /** Mark rows whose rulesKey no longer matches (after a profile or library edit) as pending re-check. */
  invalidateRules(filter: {
    libraryId?: number;
    profileId?: number;
  }): Promise<number>;
}

// ---------- scanner ----------

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

/** Pure: should this entry be (re)probed? Compares path+size+mtime+rulesKey against the stored row. */
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

/** Pure: classifies a directory listing: a folder with BDMV/index.bdmv is a disc, *.iso is an image, else media files. */
export type ClassifyEntry = (
  path: string,
  isDirectory: boolean,
  childNames: string[],
) => MediaFileKind | null;

// ---------- dry run ----------

export interface DryRunService {
  /** Aggregates probed media_files rows; reads only, writes nothing. */
  report(options: { libraryId?: number }): Promise<DryRunReport>;
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
  update(
    name: TaskName,
    patch: { intervalMinutes?: number; enabled?: boolean },
  ): Promise<ScheduledTaskInfo>;
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
