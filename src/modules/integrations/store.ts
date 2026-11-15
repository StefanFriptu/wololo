import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
  type ArrInstanceRow,
  arrInstances,
  type DownloadClientRow,
  downloadClient,
  type PathMappingRow,
  type PlexConnectionRow,
  pathMappings,
  plexConnection,
} from '../../db/schema.ts';
import type { ArrInstance, DownloadClientConnection, PathMapping, PathMappingScope } from '../../shared/domain.ts';

const SINGLETON_ID = 1;

export function toArrInstance(row: ArrInstanceRow): ArrInstance {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    apiKey: row.apiKey,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listArrInstances(db: Db): ArrInstance[] {
  return db.select().from(arrInstances).orderBy(asc(arrInstances.id)).all().map(toArrInstance);
}

export function findArrInstance(db: Db, id: number): ArrInstance | null {
  const row = db.select().from(arrInstances).where(eq(arrInstances.id, id)).get();
  return row ? toArrInstance(row) : null;
}

export function findArrInstanceByName(db: Db, name: string): ArrInstance | null {
  const row = db.select().from(arrInstances).where(eq(arrInstances.name, name)).get();
  return row ? toArrInstance(row) : null;
}

export type ArrInstanceValues = Pick<ArrInstance, 'kind' | 'name' | 'url' | 'apiKey' | 'enabled'>;

export function insertArrInstance(db: Db, values: ArrInstanceValues): ArrInstance {
  const row = db.insert(arrInstances).values(values).returning().get();
  return toArrInstance(row);
}

export function updateArrInstance(db: Db, { id, values }: { id: number; values: ArrInstanceValues }): ArrInstance {
  const row = db
    .update(arrInstances)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(arrInstances.id, id))
    .returning()
    .get();
  return toArrInstance(row as ArrInstanceRow);
}

export function deleteArrInstance(db: Db, id: number): boolean {
  return db.delete(arrInstances).where(eq(arrInstances.id, id)).returning({ id: arrInstances.id }).all().length > 0;
}

export function getPlexRow(db: Db): PlexConnectionRow | null {
  return db.select().from(plexConnection).where(eq(plexConnection.id, SINGLETON_ID)).get() ?? null;
}

/** Creates the singleton with a fresh client identifier on first use; the identifier never changes afterwards. */
export function ensurePlexRow(db: Db, newClientIdentifier: () => string): PlexConnectionRow {
  const existing = getPlexRow(db);
  if (existing) return existing;
  db.insert(plexConnection)
    .values({ id: SINGLETON_ID, clientIdentifier: newClientIdentifier() })
    .onConflictDoNothing()
    .run();
  return getPlexRow(db) as PlexConnectionRow;
}

export type PlexRowPatch = Partial<Omit<PlexConnectionRow, 'id' | 'clientIdentifier' | 'updatedAt'>>;

export function updatePlexRow(db: Db, patch: PlexRowPatch): PlexConnectionRow {
  return db
    .update(plexConnection)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(plexConnection.id, SINGLETON_ID))
    .returning()
    .get() as PlexConnectionRow;
}

export function toDownloadClient(row: DownloadClientRow): DownloadClientConnection {
  return {
    kind: row.kind,
    enabled: row.enabled,
    url: row.url,
    username: row.username,
    password: row.password,
    removeWhenGoalMet: row.removeWhenGoalMet,
    category: row.category,
  };
}

export function getDownloadClient(db: Db): DownloadClientConnection | null {
  const row = db.select().from(downloadClient).where(eq(downloadClient.id, SINGLETON_ID)).get();
  return row ? toDownloadClient(row) : null;
}

export function saveDownloadClient(db: Db, values: DownloadClientConnection): DownloadClientConnection {
  const set = { ...values, updatedAt: new Date().toISOString() };
  const row = db
    .insert(downloadClient)
    .values({ id: SINGLETON_ID, ...set })
    .onConflictDoUpdate({ target: downloadClient.id, set })
    .returning()
    .get();
  return toDownloadClient(row);
}

export function deleteDownloadClient(db: Db): void {
  db.delete(downloadClient).where(eq(downloadClient.id, SINGLETON_ID)).run();
}

export function toPathMapping(row: PathMappingRow): PathMapping {
  return {
    id: row.id,
    scope: row.scope,
    instanceId: row.instanceId,
    remotePath: row.remotePath,
    localPath: row.localPath,
  };
}

export function listPathMappings(db: Db, scope?: PathMappingScope): PathMapping[] {
  return db
    .select()
    .from(pathMappings)
    .where(scope ? eq(pathMappings.scope, scope) : undefined)
    .orderBy(asc(pathMappings.id))
    .all()
    .map(toPathMapping);
}

export function findPathMapping(db: Db, id: number): PathMapping | null {
  const row = db.select().from(pathMappings).where(eq(pathMappings.id, id)).get();
  return row ? toPathMapping(row) : null;
}

export type PathMappingValues = Omit<PathMapping, 'id'>;

export function insertPathMapping(db: Db, values: PathMappingValues): PathMapping {
  return toPathMapping(db.insert(pathMappings).values(values).returning().get());
}

export function updatePathMapping(db: Db, { id, values }: { id: number; values: PathMappingValues }): PathMapping {
  const row = db.update(pathMappings).set(values).where(eq(pathMappings.id, id)).returning().get();
  return toPathMapping(row as PathMappingRow);
}

export function deletePathMapping(db: Db, id: number): boolean {
  return db.delete(pathMappings).where(eq(pathMappings.id, id)).returning({ id: pathMappings.id }).all().length > 0;
}
