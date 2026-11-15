import type {
  JobState,
  JobStep,
  JobSummary,
  LogEntry,
  MediaFileStatus,
  QueueState,
  ScheduledTaskInfo,
  TaskName,
} from './domain.ts';

export interface ScanStats {
  filesSeen: number;
  filesNew: number;
  filesChanged: number;
  filesRemoved: number;
  filesProbed: number;
  probeErrors: number;
  jobsQueued: number;
}

/**
 * Every event published on the in-process bus and streamed to the UI over SSE (GET /api/v1/events).
 * SSE frames use the map key as `event:` and the JSON payload as `data:`.
 */
export interface EventMap {
  'job.queued': { job: JobSummary };
  'job.started': { job: JobSummary };
  'job.progress': {
    jobId: number;
    step: JobStep;
    /** 0..1 */
    progress: number;
    speed: number | null;
    etaSec: number | null;
    outTimeSec: number | null;
  };
  'job.step': { jobId: number; step: JobStep; message: string | null };
  'job.finished': {
    job: JobSummary;
    state: Extract<JobState, 'completed' | 'failed' | 'cancelled'>;
  };
  'job.removed': { jobId: number };
  'queue.state': QueueState;
  'media.updated': {
    mediaFileId: number;
    status: MediaFileStatus;
    path: string;
  };
  'media.removed': { mediaFileId: number };
  'scan.started': { scanId: string; libraryId: number | null };
  'scan.progress': {
    scanId: string;
    stats: ScanStats;
    currentPath: string | null;
  };
  'scan.finished': { scanId: string; stats: ScanStats; error: string | null };
  'task.started': { name: TaskName };
  'task.finished': { task: ScheduledTaskInfo };
  'bdmv.decision': { decisionId: number; mediaFileId: number };
  'settings.changed': { sections: string[] };
  'log.entry': LogEntry;
}

export type EventName = keyof EventMap;

export type ServerEvent = {
  [K in EventName]: { name: K; payload: EventMap[K] };
}[EventName];

export const EVENT_NAMES = [
  'job.queued',
  'job.started',
  'job.progress',
  'job.step',
  'job.finished',
  'job.removed',
  'queue.state',
  'media.updated',
  'media.removed',
  'scan.started',
  'scan.progress',
  'scan.finished',
  'task.started',
  'task.finished',
  'bdmv.decision',
  'settings.changed',
  'log.entry',
] as const satisfies readonly EventName[];

type MissingEventNames = Exclude<EventName, (typeof EVENT_NAMES)[number]>;
export const EVENT_NAMES_COMPLETE: MissingEventNames extends never
  ? true
  : MissingEventNames = true;
