import { and, asc, count, desc, eq, inArray, isNotNull, lt, ne, notExists, notInArray, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
  type JobHistoryRow,
  type JobRow,
  jobHistory,
  jobs,
  mediaFiles,
  type NewJobRow,
  recycleBin,
} from '../../db/schema.ts';
import type { HistoryEventType, JobState, JobType } from '../../shared/domain.ts';

const ACTIVE_STATES: JobState[] = ['queued', 'running'];

export interface PageWindow {
  page: number;
  pageSize: number;
  sortDir: 'asc' | 'desc';
}

const nowIso = () => new Date().toISOString();

export function insertJobRow(db: Db, values: NewJobRow): JobRow {
  return db.insert(jobs).values(values).returning().get();
}

export function getJobRow(db: Db, id: number): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function updateJobRow(db: Db, id: number, patch: Partial<NewJobRow>): JobRow | undefined {
  return db
    .update(jobs)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(jobs.id, id))
    .returning()
    .get();
}

export function deleteJobRow(db: Db, id: number): void {
  db.delete(jobs).where(eq(jobs.id, id)).run();
}

export function findActiveJobForMedia(db: Db, mediaFileId: number): JobRow | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.mediaFileId, mediaFileId), inArray(jobs.state, ACTIVE_STATES)))
    .orderBy(asc(jobs.id))
    .get();
}

/** Atomically moves the highest-priority oldest queued job to running. */
export function claimNextQueued(db: Db): JobRow | undefined {
  return db.transaction((tx) => {
    const next = tx
      .select({ id: jobs.id, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.state, 'queued'))
      .orderBy(desc(jobs.priority), asc(jobs.id))
      .get();
    if (!next) return undefined;
    const now = nowIso();
    return tx
      .update(jobs)
      .set({
        state: 'running',
        step: 'preparing',
        attempts: next.attempts + 1,
        startedAt: now,
        finishedAt: null,
        progress: 0,
        speed: null,
        etaSec: null,
        error: null,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, next.id), eq(jobs.state, 'queued')))
      .returning()
      .get();
  });
}

export function countJobsInState(db: Db, state: JobState): number {
  return db.select({ value: count() }).from(jobs).where(eq(jobs.state, state)).get()?.value ?? 0;
}

export function jobsInState(db: Db, state: JobState): JobRow[] {
  return db.select().from(jobs).where(eq(jobs.state, state)).orderBy(asc(jobs.id)).all();
}

/** Running jobs first, then queued in pick order. */
export function queueRows(db: Db, limit: number): JobRow[] {
  const running = jobsInState(db, 'running');
  const queued = db
    .select()
    .from(jobs)
    .where(eq(jobs.state, 'queued'))
    .orderBy(desc(jobs.priority), asc(jobs.id))
    .limit(limit)
    .all();
  return [...running, ...queued];
}

export function idleJobsWithTempPath(db: Db): JobRow[] {
  return db
    .select()
    .from(jobs)
    .where(and(isNotNull(jobs.tempPath), ne(jobs.state, 'running')))
    .all();
}

export function existingJobIds(db: Db, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, ids)).all();
  return new Set(rows.map((row) => row.id));
}

export function finishedJobIdsBeforeQuery(db: Db, options: { ids: number[]; beforeIso: string }) {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.id, options.ids),
        notInArray(jobs.state, ACTIVE_STATES),
        isNotNull(jobs.finishedAt),
        lt(jobs.finishedAt, options.beforeIso),
      ),
    );
}

export function finishedJobIdsBefore(db: Db, ids: number[], beforeIso: string): Set<number> {
  if (ids.length === 0) return new Set();
  return new Set(
    finishedJobIdsBeforeQuery(db, { ids, beforeIso })
      .all()
      .map((row) => row.id),
  );
}

/** Finished jobs older than beforeIso that no recycle bin entry and no media file (as its last job) points at. */
export function prunableJobIdsQuery(db: Db, options: { beforeIso: string; limit: number }) {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        notInArray(jobs.state, ACTIVE_STATES),
        lt(jobs.finishedAt, options.beforeIso),
        notExists(db.select({ id: recycleBin.id }).from(recycleBin).where(eq(recycleBin.jobId, jobs.id))),
        notExists(db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.lastJobId, jobs.id))),
      ),
    )
    .limit(options.limit);
}

export function deleteJobRows(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  return db.delete(jobs).where(inArray(jobs.id, ids)).returning({ id: jobs.id }).all().length;
}

export function expiredHistoryIdsQuery(db: Db, options: { beforeIso: string; limit: number }) {
  return db
    .select({ id: jobHistory.id })
    .from(jobHistory)
    .where(lt(jobHistory.createdAt, options.beforeIso))
    .limit(options.limit);
}

export function deleteHistoryRows(db: Db, ids: number[]): number {
  if (ids.length === 0) return 0;
  return db.delete(jobHistory).where(inArray(jobHistory.id, ids)).returning({ id: jobHistory.id }).all().length;
}

export function tempPathReferencedQuery(db: Db, path: string) {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(inArray(jobs.tempPath, [path, `${path}/`]))
    .limit(1);
}

export function isTempPathReferenced(db: Db, path: string): boolean {
  return tempPathReferencedQuery(db, path).get() !== undefined;
}

export function listJobRows(
  db: Db,
  filter: { states?: JobState[]; type?: JobType; mediaFileId?: number },
  window: PageWindow,
): { rows: JobRow[]; total: number } {
  const conditions: SQL[] = [];
  if (filter.states?.length) conditions.push(inArray(jobs.state, filter.states));
  if (filter.type) conditions.push(eq(jobs.type, filter.type));
  if (filter.mediaFileId !== undefined) conditions.push(eq(jobs.mediaFileId, filter.mediaFileId));
  const where = conditions.length ? and(...conditions) : undefined;
  const total = db.select({ value: count() }).from(jobs).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(window.sortDir === 'asc' ? asc(jobs.id) : desc(jobs.id))
    .limit(window.pageSize)
    .offset((window.page - 1) * window.pageSize)
    .all();
  return { rows, total };
}

export function insertHistoryRow(db: Db, values: typeof jobHistory.$inferInsert): void {
  db.insert(jobHistory).values(values).run();
}

export function listHistoryRows(
  db: Db,
  filter: { event?: HistoryEventType; mediaFileId?: number; jobId?: number },
  window: PageWindow,
): { rows: JobHistoryRow[]; total: number } {
  const conditions: SQL[] = [];
  if (filter.event) conditions.push(eq(jobHistory.event, filter.event));
  if (filter.mediaFileId !== undefined) conditions.push(eq(jobHistory.mediaFileId, filter.mediaFileId));
  if (filter.jobId !== undefined) conditions.push(eq(jobHistory.jobId, filter.jobId));
  const where = conditions.length ? and(...conditions) : undefined;
  const total = db.select({ value: count() }).from(jobHistory).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(jobHistory)
    .where(where)
    .orderBy(window.sortDir === 'asc' ? asc(jobHistory.id) : desc(jobHistory.id))
    .limit(window.pageSize)
    .offset((window.page - 1) * window.pageSize)
    .all();
  return { rows, total };
}
