export interface JobLogFile {
  name: string;
  mtimeMs: number;
}

export const JOB_LOG_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_LOG_PATTERN = /^(\d+)\.txt$/;

/** Job id of a per-job log file name ("42.txt" -> 42), null for anything else. */
export function jobIdOfLog(name: string): number | null {
  const id = JOB_LOG_PATTERN.exec(name)?.[1];
  return id === undefined ? null : Number(id);
}

/** Job logs older than the age limit whose job no longer exists. */
export function selectStaleJobLogs(input: {
  files: readonly JobLogFile[];
  existingJobIds: ReadonlySet<number>;
  nowMs: number;
  maxAgeDays?: number;
}): string[] {
  const cutoff = input.nowMs - (input.maxAgeDays ?? JOB_LOG_MAX_AGE_DAYS) * DAY_MS;
  return input.files
    .filter((file) => {
      const jobId = jobIdOfLog(file.name);
      return jobId !== null && file.mtimeMs < cutoff && !input.existingJobIds.has(jobId);
    })
    .map((file) => file.name);
}
