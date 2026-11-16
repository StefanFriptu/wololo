import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { libraries, libraryProfiles, libraryRoots } from '../../db/schema.ts';
import type { Library } from '../../shared/domain.ts';

/** Libraries with roots (freeBytes/accessible not filled in) and assigned profile ids, ordered by name. */
export function libraryQuery(db: Db, filter: { id?: number } = {}): Library[] {
  const rows =
    filter.id === undefined
      ? db.select().from(libraries).orderBy(asc(libraries.name)).all()
      : db.select().from(libraries).where(eq(libraries.id, filter.id)).all();
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const roots = db
    .select()
    .from(libraryRoots)
    .where(inArray(libraryRoots.libraryId, ids))
    .orderBy(asc(libraryRoots.id))
    .all();
  const profiles = db
    .select()
    .from(libraryProfiles)
    .where(inArray(libraryProfiles.libraryId, ids))
    .orderBy(asc(libraryProfiles.profileId))
    .all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    roots: roots
      .filter((root) => root.libraryId === row.id)
      .map((root) => ({ id: root.id, path: root.path, freeBytes: null, accessible: true })),
    profileIds: profiles.filter((profile) => profile.libraryId === row.id).map((profile) => profile.profileId),
    mode: row.mode,
    keepLanguages: row.keepLanguages,
    keepOriginalLanguage: row.keepOriginalLanguage,
    keepUndetermined: row.keepUndetermined,
    fillMissingLanguage: row.fillMissingLanguage,
    arrInstanceId: row.arrInstanceId,
    bdmvEnabled: row.bdmvEnabled,
    discsOnly: row.discsOnly,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function allRootsQuery(db: Db): { id: number; path: string; libraryId: number }[] {
  return db.select().from(libraryRoots).all();
}
