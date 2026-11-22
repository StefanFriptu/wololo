import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { chunk, IN_LIST_CHUNK_SIZE } from '../../core/chunk.ts';
import type { Db } from '../../db/client.ts';
import { jobs, mediaFiles, recycleBin } from '../../db/schema.ts';
import type { JobType, MediaFileKind, MediaFileStatus } from '../../shared/domain.ts';

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
export function replacedOriginals(db: Db): { recyclePath: string; mediaFileId: number | null }[] {
  return db
    .select({ recyclePath: recycleBin.recyclePath, mediaFileId: recycleBin.mediaFileId })
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
    .all();
}

export const libraryCopiesAtQuery = (db: Db, paths: string[]) =>
  db
    .select({ id: mediaFiles.id, path: mediaFiles.path, status: mediaFiles.status })
    .from(mediaFiles)
    .where(inArray(mediaFiles.path, paths));

/** media_files rows at exactly these paths. */
export function libraryCopiesAt(
  db: Db,
  paths: readonly string[],
): Map<string, { id: number; status: MediaFileStatus }> {
  const found = new Map<string, { id: number; status: MediaFileStatus }>();
  for (const part of chunk(paths, IN_LIST_CHUNK_SIZE)) {
    for (const row of libraryCopiesAtQuery(db, part).all()) found.set(row.path, { id: row.id, status: row.status });
  }
  return found;
}

export const audioJobSourcePathsQuery = (db: Db, mediaFileId: number) =>
  db
    .selectDistinct({ sourcePath: jobs.sourcePath })
    .from(jobs)
    .where(and(eq(jobs.mediaFileId, mediaFileId), eq(jobs.type, 'audio'), eq(jobs.state, 'completed')));

/** Source paths of a media file's completed audio jobs: where it lived before a conversion renamed it. */
export function audioJobSourcePaths(db: Db, mediaFileId: number): string[] {
  return audioJobSourcePathsQuery(db, mediaFileId)
    .all()
    .map((row) => row.sourcePath);
}

export const restoredSinceQuery = (db: Db, mediaFileIds: number[], sinceIso: string) =>
  db
    .select({ id: recycleBin.id })
    .from(recycleBin)
    .where(and(inArray(recycleBin.mediaFileId, mediaFileIds), gte(recycleBin.restoredAt, sinceIso)))
    .limit(1);

/** True when a recycle-bin entry of one of these media files was restored at or after sinceIso. */
export function restoredSince(db: Db, mediaFileIds: readonly number[], sinceIso: string): boolean {
  return chunk(mediaFileIds, IN_LIST_CHUNK_SIZE).some((part) => restoredSinceQuery(db, part, sinceIso).get() != null);
}
