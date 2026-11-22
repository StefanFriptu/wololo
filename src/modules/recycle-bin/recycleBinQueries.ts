import { and, asc, count, desc, eq, isNull, lte, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { jobs, type RecycleBinRow, recycleBin } from '../../db/schema.ts';
import type { SortDir } from '../../shared/domain.ts';

const nowIso = () => new Date().toISOString();

const active = () => and(isNull(recycleBin.restoredAt), isNull(recycleBin.purgedAt));

export function insertRecycleRow(db: Db, values: typeof recycleBin.$inferInsert): RecycleBinRow {
  return db.insert(recycleBin).values(values).returning().get();
}

export function getRecycleRow(db: Db, id: number): RecycleBinRow | undefined {
  return db.select().from(recycleBin).where(eq(recycleBin.id, id)).get();
}

export function recyclePathTaken(db: Db, recyclePath: string): boolean {
  return (
    db.select({ id: recycleBin.id }).from(recycleBin).where(eq(recycleBin.recyclePath, recyclePath)).get() !== undefined
  );
}

export function markRecycleRow(db: Db, id: number, patch: { restoredAt?: string; purgedAt?: string }): RecycleBinRow {
  const row = db.update(recycleBin).set(patch).where(eq(recycleBin.id, id)).returning().get();
  if (!row) throw new Error(`recycle bin entry ${id} vanished`);
  return row;
}

export function deleteRecycleRow(db: Db, id: number): void {
  db.update(jobs).set({ recycleBinEntryId: null, updatedAt: nowIso() }).where(eq(jobs.recycleBinEntryId, id)).run();
  db.delete(recycleBin).where(eq(recycleBin.id, id)).run();
}

export function linkJobToRecycleRow(db: Db, jobId: number, entryId: number): void {
  db.update(jobs).set({ recycleBinEntryId: entryId, updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
}

export function insertRecycleRowForJob(
  db: Db,
  values: typeof recycleBin.$inferInsert & { jobId: number },
): RecycleBinRow {
  return db.transaction((tx) => {
    const row = tx.insert(recycleBin).values(values).returning().get();
    tx.update(jobs).set({ recycleBinEntryId: row.id, updatedAt: nowIso() }).where(eq(jobs.id, values.jobId)).run();
    return row;
  });
}

export function listActiveRecycleRows(
  db: Db,
  window: { page: number; pageSize: number; sortDir: SortDir },
): { rows: RecycleBinRow[]; total: number } {
  const total = db.select({ value: count() }).from(recycleBin).where(active()).get()?.value ?? 0;
  const rows = db
    .select()
    .from(recycleBin)
    .where(active())
    .orderBy(window.sortDir === 'asc' ? asc(recycleBin.id) : desc(recycleBin.id))
    .limit(window.pageSize)
    .offset((window.page - 1) * window.pageSize)
    .all();
  return { rows, total };
}

export function purgeableRecycleRows(db: Db, options: { all: boolean; nowIso: string }): RecycleBinRow[] {
  const conditions: SQL[] = [isNull(recycleBin.restoredAt), isNull(recycleBin.purgedAt)];
  if (!options.all) conditions.push(lte(recycleBin.expiresAt, options.nowIso));
  return db
    .select()
    .from(recycleBin)
    .where(and(...conditions))
    .orderBy(asc(recycleBin.id))
    .all();
}
