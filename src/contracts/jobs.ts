/**
 * Contract: jobs module (src/modules/jobs, src/modules/recycle-bin).
 * Owns writes to: jobs, job_history, recycle_bin.
 *
 * Replace sequence of an audio job (never leaves the library path empty, never loses a file):
 *   1. jobs row: step "replacing", temp_path = verified temp file (persisted BEFORE touching the original).
 *   2. recycleBin.recycleForReplace(original): hard link original -> bin path (same filesystem) + recycle_bin row,
 *      jobs.recycle_bin_entry_id set. Recycle bin disabled: no link, no row.
 *   3. fsync(temp), uid/gid/mode copied first. Same path (mkv): rename(temp, original) atomically swaps the inode.
 *      New path (mp4 -> mkv): link(temp, output) (fails with EEXIST instead of overwriting), then unlink(temp) and
 *      unlink(original); without hard links: re-check that output does not exist, then rename. fsync(parent dir).
 *   4. jobs row: step "notifying", temp_path = null.
 * Before ffmpeg starts, the executor lstat()s the temp path and unlinks a leftover file or symlink: the argv carries -y
 * and ffmpeg's in-place guard only compares names, so a link to the input at that path would truncate the original.
 * If the filesystem refuses hard links (EPERM/ENOTSUP on some FUSE/SMB mounts), step 2 falls back to rename(original,
 * bin) and recover() below closes the short window where the library path is empty.
 */
import type { RunOptions, RunResult } from '../core/process.ts';
import type {
  EnqueueRequest,
  EnqueueResponse,
  HistoryQuery,
  JobQuery,
  PageQuery,
  Paginated,
  QueueResponse,
  RecycleBinPurgeResult,
} from '../shared/api-types.ts';
import type {
  BdmvJobPlan,
  ConversionPlan,
  HistoryData,
  HistoryEntry,
  HistoryEventType,
  JobDetail,
  JobStep,
  JobSummary,
  JobTrigger,
  JobType,
  MediaStream,
  QueuePauseReason,
  QueueState,
  RecycleBinEntry,
  StreamKind,
  VerificationResult,
} from '../shared/domain.ts';

/**
 * Audio jobs write "<dir>/<stem>.wololo-tmp.<ext>" next to the source. BDMV jobs write everything (ISO extraction,
 * audio side files, the temp mkv) into one directory "<radarr root>/.wololo-tmp-<jobId>/". Either path is stored in
 * jobs.temp_path before the first byte is written, so recovery can find it.
 */
export const TEMP_FILE_MARKER = '.wololo-tmp';

export interface NewJob {
  type: JobType;
  trigger: JobTrigger;
  mediaFileId: number;
  priority?: number;
  title?: string;
  /**
   * Precomputed plan (audio) or BDMV plan (from bdmv.evaluate), stored on the job for the UI. The executors never
   * trust it: the audio executor re-plans from a fresh probe, bdmv.execute re-analyzes the disc in step preparing. The
   * scan backlog enqueues disc rows without a BdmvJobPlan for that reason.
   */
  plan?: ConversionPlan | null;
  bdmvPlan?: BdmvJobPlan | null;
}

export interface JobsService {
  /** Idempotent per media file: returns the existing queued/running job instead of creating a second one. */
  enqueue(job: NewJob): Promise<JobSummary>;
  /**
   * mediaFileIds or filter (expanded through media.list in pages of 500; default status "needs_work").
   * Rows not in needs_work are skipped unless force; disc rows (kind bdmv|iso) are re-evaluated with bdmv.evaluate and
   * enqueued with that BdmvJobPlan (skipped when it has none, e.g. a pending decision).
   */
  enqueueMany(request: EnqueueRequest): Promise<EnqueueResponse>;
  list(query: JobQuery): Promise<Paginated<JobSummary>>;
  get(id: number): Promise<JobDetail>;
  /** Full per-job log text, or null when no log exists. */
  log(id: number): Promise<string | null>;
  cancel(id: number): Promise<JobSummary>;
  retry(id: number): Promise<JobSummary>;
  remove(id: number): Promise<void>;
  queue(): Promise<QueueResponse>;
  state(): QueueState;
  pause(reason: QueuePauseReason): QueueState;
  /** resume('plex_streaming') re-polls Plex now: plex.update calls it so a changed connection applies at once. */
  resume(reason: QueuePauseReason): QueueState;
  history(query: HistoryQuery): Promise<Paginated<HistoryEntry>>;
  addHistory(entry: {
    event: HistoryEventType;
    path: string;
    message: string;
    jobId?: number | null;
    mediaFileId?: number | null;
    data?: HistoryData | null;
  }): Promise<void>;
  /**
   * Startup crash recovery, for every job left in state "running", in this order:
   *   1. step "replacing" (audio): resolve the swap first.
   *      - temp file exists and original path exists -> the rename did not happen: keep the original, drop the bin
   *        link/row if one was made (the original is intact), delete the temp file, re-queue.
   *      - temp file exists and original path missing -> fallback rename happened: rename(temp, original), keep the bin row,
   *        finish the job as completed (verification already passed before "replacing").
   *      - temp file missing and original path exists -> the swap completed: finish the job as completed.
   *      - both missing -> restore from the bin row when there is one, else mark failed ("source missing").
   *      - temp file and a new output path (mp4 -> mkv) are the same inode -> the no-clobber link happened: unlink the
   *        temp file and the old source, finish the job as completed.
   *      - temp file exists, original missing, and an unrelated file sits at a new output path -> never overwrite it:
   *        restore the original from the bin (delete the temp file, re-queue), else mark failed.
   *   2. step "notifying" (audio) and the output path exists -> the swap completed: finish the job as completed
   *      (fresh probe, media.recordJobResult, notifier.fileChanged, "completed" history).
   *   3. any other step: delete jobs.temp_path (file or directory, only if its name contains TEMP_FILE_MARKER), re-queue
   *      with trigger "recovery".
   * Only after that, housekeeping-style sweeps may delete orphaned "*.wololo-tmp*" entries.
   */
  recover(): Promise<{ requeued: number; completed: number; tempFilesDeleted: number }>;
  /** Periodic cleanup (old job logs, orphaned temp files of jobs that are not running). Returns a short summary. */
  housekeeping(): Promise<string>;
  /** Starts the worker loop (honours concurrency, processing window and Plex auto-pause). */
  start(): Promise<void>;
  /** Stops taking jobs, aborts running children and leaves them re-queueable. */
  stop(): Promise<void>;
}

export interface JobLog {
  line(text: string): void;
  section(title: string): void;
}

export interface VerifyRequest {
  sourcePath: string;
  outputPath: string;
  expectedDurationSec: number;
  /** Default 0.1 (100 ms). */
  durationToleranceSec?: number;
  expectedStreamCount: number;
  /** Compare the video stream hash (ffmpeg -f streamhash -hash md5) of source and output. Off for BDMV, see ARCHITECTURE.md "v1 scope decisions". */
  compareVideoHash: boolean;
  /** Video packet count of the output (ffprobe -count_packets); BDMV's substitute for the hash. Skipped when omitted. */
  expectedVideoPackets?: number;
  /** Absolute output stream indexes (ffprobe `index` of the output file) of audio streams to decode fully (`-f null`). */
  decodeAudioStreams: number[];
  /** Chapter count the output must have (source probe, or the playlist's chapter marks). Skipped when omitted. */
  expectedChapterCount?: number;
  /** Language tag per output stream, in output order (from the plan). Skipped when omitted. */
  expectedLanguages?: { kind: StreamKind; language: string | null }[];
}

/** Handed by the worker to an executor for one job run. */
export interface JobRunContext {
  job: JobDetail;
  signal: AbortSignal;
  log: JobLog;
  setStep(step: JobStep, message?: string): void;
  reportProgress(update: {
    progress: number;
    speed?: number | null;
    etaSec?: number | null;
    outTimeSec?: number | null;
  }): void;
  /** Persists jobs.temp_path (file or directory) BEFORE the executor writes to it; null clears it after the final rename. */
  setTempPath(path: string | null): Promise<void>;
  /** runProcess with the job's AbortSignal, low priority (nice/ionice) and argv + stderr mirrored to the job log. */
  run(options: Omit<RunOptions, 'signal' | 'lowPriority'>): Promise<RunResult>;
  /** Throws AppError('precondition_failed') when the filesystem of dir has less than bytes * (1 + margin). */
  ensureFreeSpace(dir: string, bytes: number): Promise<void>;
  verify(request: VerifyRequest): Promise<VerificationResult>;
}

export interface JobOutcome {
  /** Stored as jobs.output_path when the job completes. */
  outputPath: string | null;
  /** The plan the executor applied (recomputed from a fresh probe); HistoryData.retagged comes from it. */
  plan?: ConversionPlan | null;
  after: MediaStream[] | null;
  lostFeatures: string[];
  verification: VerificationResult | null;
  bytesAfter: number | null;
  recycleBinEntryId: number | null;
  message: string;
}

/** Executes one job type. The jobs module owns the "audio" executor; the bdmv module provides "bdmv" through BdmvService.execute. */
export type JobExecutor = (ctx: JobRunContext) => Promise<JobOutcome>;

export interface RecycleBinService {
  list(query: PageQuery): Promise<Paginated<RecycleBinEntry>>;
  /** Moves a file into the recycle bin on the same filesystem (rename, never copy across devices). Used for deletions. */
  recycle(path: string, refs: { jobId?: number | null; mediaFileId?: number | null }): Promise<RecycleBinEntry>;
  /**
   * Replace step 2 (see header): hard-links path into the bin and records the row; the original stays in place until
   * the caller renames the temp file over it. Falls back to a rename when hard links are unsupported (mode "move").
   */
  recycleForReplace(
    path: string,
    refs: { jobId: number; mediaFileId: number | null },
  ): Promise<{ entry: RecycleBinEntry; mode: 'link' | 'move' }>;
  /**
   * Undo for a bad rule: moves the original back (the current file at originalPath goes to the bin first), then
   * media.setIgnored(mediaFileId, true, "restored from recycle bin") so scans do not convert it again until the user
   * un-ignores it, notifier.fileChanged({ kind: 'replaced' }) and a "restored" history entry.
   */
  restore(id: number): Promise<RecycleBinEntry>;
  remove(id: number): Promise<void>;
  purge(options: { all?: boolean }): Promise<RecycleBinPurgeResult>;
}
