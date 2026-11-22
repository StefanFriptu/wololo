import { and, asc, count, desc, eq, gt, inArray, type SQL, sql, sum } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { type JobRow, jobs, libraryProfiles, libraryRoots, mediaFiles } from '../../db/schema.ts';
import type { MediaFileSummary, MediaQuery, MediaSortKey } from '../../shared/api-types.ts';
import type { JobSummary, MediaFileStatus } from '../../shared/domain.ts';
import { relativeToRoot } from './paths.ts';
import { parseKindList, parseStatusList } from './schemas.ts';

const SUMMARY_COLUMNS = {
  id: mediaFiles.id,
  libraryId: mediaFiles.libraryId,
  rootId: mediaFiles.rootId,
  rootPath: libraryRoots.path,
  path: mediaFiles.path,
  kind: mediaFiles.kind,
  sizeBytes: mediaFiles.sizeBytes,
  mtimeMs: mediaFiles.mtimeMs,
  durationSec: mediaFiles.durationSec,
  status: mediaFiles.status,
  statusReason: mediaFiles.statusReason,
  videoCodec: mediaFiles.videoCodec,
  audioCodecs: mediaFiles.audioCodecs,
  subtitleLanguages: mediaFiles.subtitleLanguages,
  failingCodecs: mediaFiles.failingCodecs,
  planAction: mediaFiles.planAction,
  profileResults: mediaFiles.profileResults,
  rulesKey: mediaFiles.rulesKey,
  lastJobId: mediaFiles.lastJobId,
  probedAt: mediaFiles.probedAt,
  updatedAt: mediaFiles.updatedAt,
};

const DETAIL_COLUMNS = {
  ...SUMMARY_COLUMNS,
  probe: mediaFiles.probe,
  plan: mediaFiles.plan,
  originalLanguage: mediaFiles.originalLanguage,
  arrInstanceId: mediaFiles.arrInstanceId,
  arrKind: mediaFiles.arrKind,
  arrItemId: mediaFiles.arrItemId,
  arrFileId: mediaFiles.arrFileId,
};

const SORT_COLUMNS = {
  path: mediaFiles.path,
  size: mediaFiles.sizeBytes,
  status: mediaFiles.status,
  updatedAt: mediaFiles.updatedAt,
  duration: mediaFiles.durationSec,
} as const satisfies Record<MediaSortKey, unknown>;

export type MediaSummaryRow = {
  id: number;
  libraryId: number;
  rootId: number;
  rootPath: string | null;
  path: string;
  kind: MediaFileSummary['kind'];
  sizeBytes: number;
  mtimeMs: number;
  durationSec: number | null;
  status: MediaFileStatus;
  statusReason: string | null;
  videoCodec: string | null;
  audioCodecs: string[];
  subtitleLanguages: string[];
  failingCodecs: string[];
  planAction: MediaFileSummary['planAction'];
  profileResults: MediaFileSummary['profileResults'];
  rulesKey: string | null;
  lastJobId: number | null;
  probedAt: string | null;
  updatedAt: string;
};

export function toSummary(row: MediaSummaryRow): MediaFileSummary {
  return {
    id: row.id,
    libraryId: row.libraryId,
    path: row.path,
    relativePath: row.rootPath ? relativeToRoot(row.path, row.rootPath) : row.path,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    durationSec: row.durationSec,
    status: row.status,
    statusReason: row.statusReason,
    videoCodec: row.videoCodec,
    audioCodecs: row.audioCodecs,
    subtitleLanguages: row.subtitleLanguages,
    failingCodecs: row.failingCodecs,
    planAction: row.planAction,
    profileResults: row.profileResults,
    lastJobId: row.lastJobId,
    probedAt: row.probedAt,
    updatedAt: row.updatedAt,
  };
}

function profileCondition(db: Db, profileId: number): SQL {
  return inArray(
    mediaFiles.libraryId,
    db.select({ id: libraryProfiles.libraryId }).from(libraryProfiles).where(eq(libraryProfiles.profileId, profileId)),
  );
}

function codecListCondition(
  column: typeof mediaFiles.streamCodecs | typeof mediaFiles.failingCodecs,
  codec: string,
): SQL {
  const value = codec.toLowerCase();
  if (!value.endsWith('*')) return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`;
  const prefix = value.slice(0, -1).replace(/[\\%_]/g, (char) => `\\${char}`);
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value LIKE ${`${prefix}%`} ESCAPE '\\')`;
}

export function mediaConditions(db: Db, query: MediaQuery): SQL[] {
  const conditions: SQL[] = [];
  const statuses = parseStatusList(query.status);
  if (statuses.length > 0) conditions.push(inArray(mediaFiles.status, statuses));
  if (query.libraryId !== undefined) conditions.push(eq(mediaFiles.libraryId, query.libraryId));
  if (query.profileId !== undefined) conditions.push(profileCondition(db, query.profileId));
  if (query.codec) conditions.push(codecListCondition(mediaFiles.streamCodecs, query.codec));
  if (query.failingCodec) conditions.push(codecListCondition(mediaFiles.failingCodecs, query.failingCodec));
  const kinds = parseKindList(query.kind);
  if (kinds.length > 0) conditions.push(inArray(mediaFiles.kind, kinds));
  if (query.search) conditions.push(sql`instr(lower(${mediaFiles.path}), ${query.search.toLowerCase()}) > 0`);
  return conditions;
}

export function listMediaQuery(db: Db, query: MediaQuery): { total: number; rows: MediaSummaryRow[] } {
  const where = and(...mediaConditions(db, query));
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const column = SORT_COLUMNS[query.sortKey ?? 'path'];
  const direction = query.sortDir === 'desc' ? desc : asc;
  const total = db.select({ value: count() }).from(mediaFiles).where(where).get()?.value ?? 0;
  const rows = db
    .select(SUMMARY_COLUMNS)
    .from(mediaFiles)
    .leftJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(where)
    .orderBy(direction(column), direction(mediaFiles.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  return { total, rows };
}

export function mediaAfterPathQuery(
  db: Db,
  query: MediaQuery,
  cursor: { afterPath: string | null; limit: number },
): MediaSummaryRow[] {
  const conditions = mediaConditions(db, query);
  if (cursor.afterPath !== null) conditions.push(gt(mediaFiles.path, cursor.afterPath));
  return db
    .select(SUMMARY_COLUMNS)
    .from(mediaFiles)
    .leftJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(and(...conditions))
    .orderBy(asc(mediaFiles.path))
    .limit(cursor.limit)
    .all();
}

export function mediaDetailQuery(db: Db, where: { id: number } | { path: string }) {
  return db
    .select(DETAIL_COLUMNS)
    .from(mediaFiles)
    .leftJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where('id' in where ? eq(mediaFiles.id, where.id) : eq(mediaFiles.path, where.path))
    .get();
}

export type MediaDetailRow = NonNullable<ReturnType<typeof mediaDetailQuery>>;

export function mediaStatsQuery(db: Db, libraryId?: number) {
  const scope = libraryId === undefined ? undefined : eq(mediaFiles.libraryId, libraryId);
  const totals = db
    .select({ total: count(), totalBytes: sum(mediaFiles.sizeBytes) })
    .from(mediaFiles)
    .where(scope)
    .get();
  const byStatus = db
    .select({ status: mediaFiles.status, count: count() })
    .from(mediaFiles)
    .where(scope)
    .groupBy(mediaFiles.status)
    .all();
  const libraryFilter = libraryId === undefined ? sql`` : sql`AND m.library_id = ${libraryId}`;
  const byFailingCodec = db.all<{ codec: string; count: number }>(sql`
    SELECT f.value AS codec, COUNT(*) AS count
    FROM media_files m, json_each(m.failing_codecs) f
    WHERE m.status != 'ignored' ${libraryFilter}
    GROUP BY f.value
    ORDER BY count DESC, codec ASC`);
  return {
    total: totals?.total ?? 0,
    totalBytes: Number(totals?.totalBytes ?? 0),
    byStatus,
    byFailingCodec: byFailingCodec.map((row) => ({ codec: row.codec, count: Number(row.count) })),
  };
}

function toJobSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    step: row.step,
    priority: row.priority,
    trigger: row.trigger,
    mediaFileId: row.mediaFileId,
    libraryId: row.libraryId,
    profileId: row.profileId,
    sourcePath: row.sourcePath,
    outputPath: row.outputPath,
    title: row.title,
    progress: row.progress,
    speed: row.speed,
    etaSec: row.etaSec,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function jobsForMediaQuery(db: Db, mediaFileId: number, limit = 20): JobSummary[] {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.mediaFileId, mediaFileId))
    .orderBy(desc(jobs.id))
    .limit(limit)
    .all()
    .map(toJobSummary);
}

/** Media file ids with a queued or running job, limited to the given ids. */
const STORED_ENTRY_COLUMNS = {
  id: mediaFiles.id,
  path: mediaFiles.path,
  kind: mediaFiles.kind,
  sizeBytes: mediaFiles.sizeBytes,
  mtimeMs: mediaFiles.mtimeMs,
  rulesKey: mediaFiles.rulesKey,
  status: mediaFiles.status,
  profileResults: mediaFiles.profileResults,
};

export function storedEntryQuery(db: Db, options: { rootId: number; path: string }) {
  return db
    .select(STORED_ENTRY_COLUMNS)
    .from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, options.rootId), eq(mediaFiles.path, options.path)))
    .get();
}

export function rootEntriesPageQuery(db: Db, options: { rootId: number; afterId: number; limit: number }) {
  return db
    .select(STORED_ENTRY_COLUMNS)
    .from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, options.rootId), gt(mediaFiles.id, options.afterId)))
    .orderBy(asc(mediaFiles.id))
    .limit(options.limit)
    .all();
}

export function activeJobMediaIdsQuery(db: Db, mediaFileIds: readonly number[]): Set<number> {
  const ids = new Set<number>();
  for (let start = 0; start < mediaFileIds.length; start += 500) {
    const chunk = mediaFileIds.slice(start, start + 500);
    const rows = db
      .select({ mediaFileId: jobs.mediaFileId })
      .from(jobs)
      .where(and(inArray(jobs.mediaFileId, chunk), inArray(jobs.state, ['queued', 'running'])))
      .all();
    for (const row of rows) if (row.mediaFileId !== null) ids.add(row.mediaFileId);
  }
  return ids;
}
