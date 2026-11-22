import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { type TorrentRemovalRow, torrentRemovals } from '../../db/schema.ts';
import type { TorrentRemoval, TorrentRemovalCondition, TorrentRemovalState } from '../../shared/domain.ts';

export function toTorrentRemoval(row: TorrentRemovalRow): TorrentRemoval {
  return {
    hash: row.hash,
    name: row.name,
    condition: row.condition,
    state: row.state,
    reason: row.reason,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export function getTorrentRemoval(db: Db, hash: string): TorrentRemovalRow | null {
  return db.select().from(torrentRemovals).where(eq(torrentRemovals.hash, hash)).get() ?? null;
}

/** A new request, or a fresh start for an earlier one: pending again, counted from nowIso. */
export function requestTorrentRemoval(
  db: Db,
  request: { hash: string; name: string; condition: TorrentRemovalCondition },
  nowIso: string,
): TorrentRemovalRow {
  const fresh = { ...request, state: 'pending' as const, reason: null, createdAt: nowIso, finishedAt: null };
  const [row] = db
    .insert(torrentRemovals)
    .values(fresh)
    .onConflictDoUpdate({ target: torrentRemovals.hash, set: fresh })
    .returning()
    .all();
  if (!row) throw new Error(`torrent removal for ${request.hash} was not saved`);
  return row;
}

export const pendingTorrentRemovalsQuery = (db: Db, limit: number) =>
  db
    .select()
    .from(torrentRemovals)
    .where(eq(torrentRemovals.state, 'pending'))
    .orderBy(asc(torrentRemovals.id))
    .limit(limit);

export function pendingTorrentRemovals(db: Db, limit: number): TorrentRemovalRow[] {
  return pendingTorrentRemovalsQuery(db, limit).all();
}

export function hasPendingTorrentRemoval(db: Db): boolean {
  return (
    db
      .select({ id: torrentRemovals.id })
      .from(torrentRemovals)
      .where(eq(torrentRemovals.state, 'pending'))
      .limit(1)
      .get() != null
  );
}

/** Ends a pending request; false when it was no longer pending. */
export function finishTorrentRemoval(
  db: Db,
  hash: string,
  outcome: { state: Exclude<TorrentRemovalState, 'pending'>; reason: string | null },
  nowIso: string,
): boolean {
  const changed = db
    .update(torrentRemovals)
    .set({ ...outcome, finishedAt: nowIso })
    .where(and(eq(torrentRemovals.hash, hash), eq(torrentRemovals.state, 'pending')))
    .returning({ id: torrentRemovals.id })
    .all();
  return changed.length > 0;
}

/** Records why a pending request still waits; no write when the reason is unchanged. */
export function keepTorrentRemovalPending(db: Db, row: TorrentRemovalRow, reason: string): void {
  if (row.reason === reason) return;
  db.update(torrentRemovals)
    .set({ reason })
    .where(and(eq(torrentRemovals.hash, row.hash), eq(torrentRemovals.state, 'pending')))
    .run();
}
