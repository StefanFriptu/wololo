import { asc, count, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { deviceProfiles, libraries, libraryProfiles } from '../../db/schema.ts';
import type { DeviceProfile } from '../../shared/domain.ts';

export function profileQuery(db: Db) {
  return {
    all: (): DeviceProfile[] => db.select().from(deviceProfiles).orderBy(asc(deviceProfiles.id)).all(),
    byId: (id: number): DeviceProfile | undefined =>
      db.select().from(deviceProfiles).where(eq(deviceProfiles.id, id)).get(),
    byName: (name: string): DeviceProfile | undefined =>
      db.select().from(deviceProfiles).where(eq(deviceProfiles.name, name)).get(),
    firstBuiltin: (): DeviceProfile | undefined =>
      db
        .select()
        .from(deviceProfiles)
        .where(eq(deviceProfiles.builtin, true))
        .orderBy(asc(deviceProfiles.id))
        .limit(1)
        .get(),
    count: (): number => db.select({ total: count() }).from(deviceProfiles).get()?.total ?? 0,
    assignments: (): { libraryId: number; profileId: number }[] =>
      db.select().from(libraryProfiles).orderBy(asc(libraryProfiles.libraryId)).all(),
    libraryIdsOf: (profileId: number): number[] =>
      db
        .select({ libraryId: libraryProfiles.libraryId })
        .from(libraryProfiles)
        .where(eq(libraryProfiles.profileId, profileId))
        .orderBy(asc(libraryProfiles.libraryId))
        .all()
        .map((row) => row.libraryId),
    libraryExists: (libraryId: number): boolean =>
      db.select({ id: libraries.id }).from(libraries).where(eq(libraries.id, libraryId)).get() !== undefined,
    assignedToLibrary: (libraryId: number): DeviceProfile[] =>
      db
        .select({ profile: deviceProfiles })
        .from(libraryProfiles)
        .innerJoin(deviceProfiles, eq(deviceProfiles.id, libraryProfiles.profileId))
        .where(eq(libraryProfiles.libraryId, libraryId))
        .orderBy(asc(deviceProfiles.id))
        .all()
        .map((row) => row.profile),
    librariesWithoutProfiles: (): number[] =>
      db
        .select({ id: libraries.id })
        .from(libraries)
        .where(notInArray(libraries.id, db.select({ id: libraryProfiles.libraryId }).from(libraryProfiles)))
        .orderBy(asc(libraries.id))
        .all()
        .map((row) => row.id),
  };
}
