import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { jobs, mediaFiles, recycleBin } from '../../db/schema.ts';
import type { JobType, MediaFileKind } from '../../shared/domain.ts';

function likePrefix(path: string): string {
  const escaped = path.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `${escaped.replace(/\/+$/, '')}/%`;
}

/** media_files rows at `path` or below it. */
export function mediaFilesWithin(db: Db, path: string): { id: number; path: string; kind: MediaFileKind }[] {
  return db
    .select({ id: mediaFiles.id, path: mediaFiles.path, kind: mediaFiles.kind })
    .from(mediaFiles)
    .where(or(eq(mediaFiles.path, path), sql`${mediaFiles.path} LIKE ${likePrefix(path)} ESCAPE '\\'`))
    .all();
}

/** Media file ids with at least one completed job of the given type. */
export function mediaFilesWithCompletedJob(db: Db, { ids, type }: { ids: number[]; type: JobType }): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .selectDistinct({ mediaFileId: jobs.mediaFileId })
    .from(jobs)
    .where(and(inArray(jobs.mediaFileId, ids), eq(jobs.state, 'completed'), eq(jobs.type, type)))
    .all();
  return new Set(rows.flatMap((row) => (row.mediaFileId == null ? [] : [row.mediaFileId])));
}

/** Recycle-bin copies (hard links) of originals replaced by a completed audio job and not restored or purged. */
export function replacedOriginalPaths(db: Db): string[] {
  return db
    .select({ recyclePath: recycleBin.recyclePath })
    .from(recycleBin)
    .innerJoin(jobs, eq(jobs.id, recycleBin.jobId))
    .where(
      and(
        isNull(recycleBin.restoredAt),
        isNull(recycleBin.purgedAt),
        eq(jobs.type, 'audio'),
        eq(jobs.state, 'completed'),
      ),
    )
    .all()
    .map((row) => row.recyclePath);
}
