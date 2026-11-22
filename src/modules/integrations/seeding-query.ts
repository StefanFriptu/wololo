import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { chunk, IN_LIST_CHUNK_SIZE } from '../../core/chunk.ts';
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
  const found = new Set<number>();
  for (const part of chunk(ids, IN_LIST_CHUNK_SIZE)) {
    const rows = db
      .selectDistinct({ mediaFileId: jobs.mediaFileId })
      .from(jobs)
      .where(and(inArray(jobs.mediaFileId, part), eq(jobs.state, 'completed'), eq(jobs.type, type)))
      .all();
    for (const row of rows) if (row.mediaFileId != null) found.add(row.mediaFileId);
  }
  return found;
}

/** Those of `paths` that are media_files rows with a completed audio job (their original was replaced). */
export function pathsReplacedByAudioJob(db: Db, paths: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const part of chunk(paths, IN_LIST_CHUNK_SIZE)) {
    const rows = db
      .selectDistinct({ path: mediaFiles.path })
      .from(mediaFiles)
      .innerJoin(jobs, eq(jobs.mediaFileId, mediaFiles.id))
      .where(and(inArray(mediaFiles.path, part), eq(jobs.type, 'audio'), eq(jobs.state, 'completed')))
      .all();
    for (const row of rows) found.add(row.path);
  }
  return found;
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
