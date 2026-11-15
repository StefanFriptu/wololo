import { count, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { libraries, libraryRoots } from '../../db/schema.ts';

export interface LibraryRootRow {
  library: string;
  path: string;
}

export function libraryCountQuery(db: Db): number {
  return db.select({ total: count() }).from(libraries).get()?.total ?? 0;
}

/** Roots of enabled libraries, for the reachability health check. */
export function enabledLibraryRootsQuery(db: Db): LibraryRootRow[] {
  return db
    .select({ library: libraries.name, path: libraryRoots.path })
    .from(libraryRoots)
    .innerJoin(libraries, eq(libraryRoots.libraryId, libraries.id))
    .where(eq(libraries.enabled, true))
    .orderBy(libraries.name, libraryRoots.path)
    .all();
}
