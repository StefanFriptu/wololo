import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { type BdmvDecisionRow, bdmvDecisions, mediaFiles } from '../../db/schema.ts';
import type {
  BdmvDecision,
  BdmvDecisionChoice,
  BdmvDecisionKind,
  BdmvDecisionState,
  BdmvTitleCandidate,
  MovieMatchCandidate,
} from '../../shared/domain.ts';

function toDecision(row: BdmvDecisionRow, sourcePath: string | null): BdmvDecision {
  return {
    id: row.id,
    mediaFileId: row.mediaFileId,
    kind: row.kind,
    state: row.state,
    sourcePath: sourcePath ?? '',
    message: row.message,
    titleCandidates: row.titleCandidates,
    movieCandidates: row.movieCandidates,
    choice: row.choice ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

function selectDecisions(db: Db) {
  return db
    .select({ decision: bdmvDecisions, sourcePath: mediaFiles.path })
    .from(bdmvDecisions)
    .leftJoin(mediaFiles, eq(mediaFiles.id, bdmvDecisions.mediaFileId));
}

export function listDecisionsQuery(db: Db, state?: BdmvDecisionState): BdmvDecision[] {
  return selectDecisions(db)
    .where(state ? eq(bdmvDecisions.state, state) : undefined)
    .orderBy(desc(bdmvDecisions.id))
    .all()
    .map((row) => toDecision(row.decision, row.sourcePath));
}

export function getDecisionQuery(db: Db, id: number): BdmvDecision | null {
  const row = selectDecisions(db).where(eq(bdmvDecisions.id, id)).get();
  return row ? toDecision(row.decision, row.sourcePath) : null;
}

export function latestDecisionQuery(db: Db, mediaFileId: number, kind: BdmvDecisionKind): BdmvDecision | null {
  const row = selectDecisions(db)
    .where(and(eq(bdmvDecisions.mediaFileId, mediaFileId), eq(bdmvDecisions.kind, kind)))
    .orderBy(desc(bdmvDecisions.id))
    .limit(1)
    .get();
  return row ? toDecision(row.decision, row.sourcePath) : null;
}

export function insertDecision(
  db: Db,
  values: {
    mediaFileId: number;
    kind: BdmvDecisionKind;
    message: string;
    titleCandidates?: BdmvTitleCandidate[];
    movieCandidates?: MovieMatchCandidate[];
  },
): number {
  const row = db
    .insert(bdmvDecisions)
    .values({
      mediaFileId: values.mediaFileId,
      kind: values.kind,
      message: values.message,
      titleCandidates: values.titleCandidates ?? [],
      movieCandidates: values.movieCandidates ?? [],
    })
    .returning({ id: bdmvDecisions.id })
    .get();
  return row.id;
}

/** Moves a pending decision to resolved/dismissed; returns false when it was no longer pending. */
export function closeDecision(
  db: Db,
  id: number,
  state: Exclude<BdmvDecisionState, 'pending'>,
  choice: BdmvDecisionChoice | null,
  now: string,
): boolean {
  const updated = db
    .update(bdmvDecisions)
    .set({ state, choice, resolvedAt: now })
    .where(and(eq(bdmvDecisions.id, id), eq(bdmvDecisions.state, 'pending')))
    .returning({ id: bdmvDecisions.id })
    .all();
  return updated.length > 0;
}
