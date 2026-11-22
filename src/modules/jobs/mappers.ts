import type { JobHistoryRow, JobRow, RecycleBinRow } from '../../db/schema.ts';
import type { HistoryEntry, JobDetail, JobSummary, RecycleBinEntry } from '../../shared/domain.ts';

export interface LiveProgress {
  progress: number;
  speed: number | null;
  etaSec: number | null;
}

export function toJobSummary(row: JobRow, live?: LiveProgress): JobSummary {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    step: row.step,
    priority: row.priority,
    trigger: row.trigger,
    mediaFileId: row.mediaFileId,
    libraryId: row.libraryId,
    profileId: row.profileId,
    sourcePath: row.sourcePath,
    outputPath: row.outputPath,
    title: row.title,
    progress: live?.progress ?? row.progress,
    speed: live ? live.speed : row.speed,
    etaSec: live ? live.etaSec : row.etaSec,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function toJobDetail(row: JobRow, options: { hasLog: boolean; live?: LiveProgress }): JobDetail {
  return {
    ...toJobSummary(row, options.live),
    plan: row.plan,
    bdmvPlan: row.bdmvPlan,
    before: row.beforeStreams,
    after: row.afterStreams,
    lostFeatures: row.lostFeatures,
    verification: row.verification,
    bytesBefore: row.bytesBefore,
    bytesAfter: row.bytesAfter,
    hasLog: options.hasLog,
    recycleBinEntryId: row.recycleBinEntryId,
  };
}

export function toHistoryEntry(row: JobHistoryRow): HistoryEntry {
  return {
    id: row.id,
    jobId: row.jobId,
    mediaFileId: row.mediaFileId,
    event: row.event,
    path: row.path,
    message: row.message,
    data: row.data,
    createdAt: row.createdAt,
  };
}

export function toRecycleBinEntry(row: RecycleBinRow): RecycleBinEntry {
  return {
    id: row.id,
    originalPath: row.originalPath,
    recyclePath: row.recyclePath,
    sizeBytes: row.sizeBytes,
    jobId: row.jobId,
    mediaFileId: row.mediaFileId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    restoredAt: row.restoredAt,
    purgedAt: row.purgedAt,
  };
}
