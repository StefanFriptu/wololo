/**
 * Contract: jobs module (src/modules/jobs, src/modules/recycle-bin).
 * Owns writes to: jobs, job_history, recycle_bin.
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
  VerificationResult,
} from '../shared/domain.ts';

/** Temp outputs are "<dir>/<stem>.wololo-tmp.<ext>" next to the source, so crash recovery can find and delete them. */
export const TEMP_FILE_MARKER = '.wololo-tmp';

export interface NewJob {
  type: JobType;
  trigger: JobTrigger;
  mediaFileId: number;
  priority?: number;
  title?: string;
  /** Precomputed plan (audio) or BDMV plan; the executor recomputes from a fresh probe before writing anything. */
  plan?: ConversionPlan | null;
  bdmvPlan?: BdmvJobPlan | null;
}

export interface JobsService {
  /** Idempotent per media file: returns the existing queued/running job instead of creating a second one. */
  enqueue(job: NewJob): Promise<JobSummary>;
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
  resume(reason: QueuePauseReason): QueueState;
  history(query: HistoryQuery): Promise<Paginated<HistoryEntry>>;
  addHistory(entry: {
    event: HistoryEventType;
    path: string;
    message: string;
    jobId?: number | null;
    mediaFileId?: number | null;
    data?: Record<string, unknown> | null;
  }): Promise<void>;
  /** Startup crash recovery: delete stale "*.wololo-tmp.*" files of interrupted jobs and re-queue them. */
  recover(): Promise<{ requeued: number; tempFilesDeleted: number }>;
  /** Periodic cleanup (old job logs, orphaned temp files). Returns a short summary for the task list. */
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
  /** Compare the video stream hash (ffmpeg -f streamhash -hash md5) of source and output. Off for BDMV (packetisation differs). */
  compareVideoHash: boolean;
  /** Output audio stream indexes to decode fully (`-f null`). */
  decodeAudioStreams: number[];
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
  /** runProcess with the job's AbortSignal, low priority (nice/ionice) and argv + stderr mirrored to the job log. */
  run(options: Omit<RunOptions, 'signal' | 'lowPriority'>): Promise<RunResult>;
  /** Throws AppError('precondition_failed') when the filesystem of dir has less than bytes * (1 + margin). */
  ensureFreeSpace(dir: string, bytes: number): Promise<void>;
  verify(request: VerifyRequest): Promise<VerificationResult>;
}

export interface JobOutcome {
  outputPath: string | null;
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
  /** Moves a file into the recycle bin on the same filesystem (rename, never copy across devices). */
  recycle(
    path: string,
    refs: { jobId?: number | null; mediaFileId?: number | null },
  ): Promise<RecycleBinEntry>;
  /** Moves the original back; the current file at originalPath goes to the bin first. */
  restore(id: number): Promise<RecycleBinEntry>;
  remove(id: number): Promise<void>;
  purge(options: { all?: boolean }): Promise<RecycleBinPurgeResult>;
}
