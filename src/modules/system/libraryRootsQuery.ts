import { count, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { libraries, libraryRoots } from '../../db/schema.ts';

export function libraryCountQuery(db: Db) {
  return db.select({ total: count() }).from(libraries);
}

/** Roots of enabled libraries, for the reachability health check. */
export function enabledLibraryRootsQuery(db: Db) {
  return db
    .select({ library: libraries.name, path: libraryRoots.path })
    .from(libraryRoots)
    .innerJoin(libraries, eq(libraryRoots.libraryId, libraries.id))
    .where(eq(libraries.enabled, true))
    .orderBy(libraries.name, libraryRoots.path);
}
