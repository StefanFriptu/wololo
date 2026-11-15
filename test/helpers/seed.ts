/**
 * Direct table inserts with defaults for tests. Tests may seed any table this way (golden rule 5 covers production
 * code only); production code writes other modules' tables only through their services.
 */
import type { Db } from '../../src/db/client.ts';
import {
  arrInstances,
  deviceProfiles,
  type JobRow,
  jobs,
  libraries,
  libraryProfiles,
  libraryRoots,
  type MediaFileRow,
  mediaFiles,
  type NewJobRow,
  type NewMediaFileRow,
} from '../../src/db/schema.ts';
import type { ArrKind, DeviceProfileDefinition } from '../../src/shared/domain.ts';

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

export function insertProfile(
  db: Db,
  definition: DeviceProfileDefinition,
  overrides: { name?: string; builtin?: boolean } = {},
): number {
  const [row] = db
    .insert(deviceProfiles)
    .values({ name: overrides.name ?? unique('profile'), builtin: overrides.builtin ?? false, definition })
    .returning({ id: deviceProfiles.id })
    .all();
  return (row as { id: number }).id;
}

export function insertArrInstance(
  db: Db,
  overrides: { kind?: ArrKind; name?: string; url?: string; apiKey?: string } = {},
): number {
  const [row] = db
    .insert(arrInstances)
    .values({
      kind: overrides.kind ?? 'radarr',
      name: overrides.name ?? unique('radarr'),
      url: overrides.url ?? 'http://radarr:7878',
      apiKey: overrides.apiKey ?? '0123456789abcdef0123456789abcdef',
    })
    .returning({ id: arrInstances.id })
    .all();
  return (row as { id: number }).id;
}

export interface SeededLibrary {
  libraryId: number;
  rootIds: number[];
}

/** Library with roots (default one root "/data/media/movies") and optional profile assignments. */
export function insertLibrary(
  db: Db,
  overrides: Partial<typeof libraries.$inferInsert> & { roots?: string[]; profileIds?: number[] } = {},
): SeededLibrary {
  const { roots = ['/data/media/movies'], profileIds = [], ...values } = overrides;
  const [library] = db
    .insert(libraries)
    .values({ name: unique('library'), ...values })
    .returning({ id: libraries.id })
    .all();
  const libraryId = (library as { id: number }).id;
  const rootIds = roots.map((path) => {
    const [root] = db.insert(libraryRoots).values({ libraryId, path }).returning({ id: libraryRoots.id }).all();
    return (root as { id: number }).id;
  });
  for (const profileId of profileIds) db.insert(libraryProfiles).values({ libraryId, profileId }).run();
  return { libraryId, rootIds };
}

export function insertMediaFile(
  db: Db,
  library: SeededLibrary,
  overrides: Partial<NewMediaFileRow> = {},
): MediaFileRow {
  const [row] = db
    .insert(mediaFiles)
    .values({
      libraryId: library.libraryId,
      rootId: library.rootIds[0] as number,
      path: `/data/media/movies/${unique('Movie')}/movie.mkv`,
      sizeBytes: 1_000_000,
      mtimeMs: 1_700_000_000_000,
      ...overrides,
    })
    .returning()
    .all();
  return row as MediaFileRow;
}

export function insertJob(db: Db, overrides: Partial<NewJobRow> & Pick<NewJobRow, 'sourcePath'>): JobRow {
  const [row] = db
    .insert(jobs)
    .values({ type: 'audio', trigger: 'manual', title: overrides.sourcePath, ...overrides })
    .returning()
    .all();
  return row as JobRow;
}
