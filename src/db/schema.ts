import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  ArrKind,
  BdmvDecisionChoice,
  BdmvDecisionKind,
  BdmvDecisionState,
  BdmvJobPlan,
  BdmvTitleCandidate,
  ConversionPlan,
  DeviceProfileDefinition,
  FillMissingLanguage,
  HistoryData,
  HistoryEventType,
  JobState,
  JobStep,
  JobTrigger,
  JobType,
  LibraryKind,
  LibraryMode,
  MediaFileKind,
  MediaFileStatus,
  MediaStream,
  MovieMatchCandidate,
  PathMappingScope,
  PlanAction,
  ProbeResult,
  ProfileResult,
  TaskName,
  VerificationResult,
} from '../shared/domain.ts';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text('created_at').notNull().default(now);
const updatedAt = () => text('updated_at').notNull().default(now);
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: updatedAt(),
});

export const arrInstances = sqliteTable('arr_instances', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').$type<ArrKind>().notNull(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  apiKey: text('api_key').notNull(),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deviceProfiles = sqliteTable('device_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  version: integer('version').notNull().default(1),
  definition: json<DeviceProfileDefinition>('definition').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').$type<LibraryKind>().notNull().default('movies'),
  enabled: bool('enabled').notNull().default(true),
  mode: text('mode').$type<LibraryMode>().notNull().default('replace'),
  keepLanguages: json<string[]>('keep_languages').notNull().default([]),
  keepOriginalLanguage: bool('keep_original_language').notNull().default(true),
  keepUndetermined: bool('keep_undetermined').notNull().default(true),
  fillMissingLanguage: text('fill_missing_language').$type<FillMissingLanguage>().notNull().default('off'),
  arrInstanceId: integer('arr_instance_id').references(() => arrInstances.id, {
    onDelete: 'set null',
  }),
  bdmvEnabled: bool('bdmv_enabled').notNull().default(true),
  discsOnly: bool('discs_only').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const libraryRoots = sqliteTable('library_roots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryId: integer('library_id')
    .notNull()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  path: text('path').notNull().unique(),
});

export const libraryProfiles = sqliteTable(
  'library_profiles',
  {
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => deviceProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.profileId] })],
);

export const mediaFiles = sqliteTable(
  'media_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    rootId: integer('root_id')
      .notNull()
      .references(() => libraryRoots.id, { onDelete: 'cascade' }),
    /** File path, or the disc folder (the one containing BDMV/) for kind "bdmv", or the .iso path. */
    path: text('path').notNull(),
    kind: text('kind').$type<MediaFileKind>().notNull().default('file'),
    sizeBytes: integer('size_bytes').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    status: text('status').$type<MediaFileStatus>().notNull().default('pending'),
    statusReason: text('status_reason'),
    /** Effective profile version key + library rule settings hash the current status was computed with. */
    rulesKey: text('rules_key'),
    probe: json<ProbeResult>('probe'),
    plan: json<ConversionPlan>('plan'),
    planAction: text('plan_action').$type<PlanAction>(),
    durationSec: real('duration_sec'),
    formatName: text('format_name'),
    videoCodec: text('video_codec'),
    audioCodecs: json<string[]>('audio_codecs').notNull().default([]),
    /** Codec of every probed stream: the media list codec filter matches it without parsing the probe JSON. */
    streamCodecs: json<string[]>('stream_codecs').notNull().default([]),
    subtitleLanguages: json<string[]>('subtitle_languages').notNull().default([]),
    failingCodecs: json<string[]>('failing_codecs').notNull().default([]),
    profileResults: json<ProfileResult[]>('profile_results'),
    originalLanguage: text('original_language'),
    arrInstanceId: integer('arr_instance_id').references(() => arrInstances.id, { onDelete: 'set null' }),
    arrKind: text('arr_kind').$type<ArrKind>(),
    arrItemId: integer('arr_item_id'),
    arrFileId: integer('arr_file_id'),
    lastJobId: integer('last_job_id'),
    probedAt: text('probed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('media_files_path_idx').on(t.path),
    index('media_files_library_idx').on(t.libraryId),
    index('media_files_status_idx').on(t.status),
    index('media_files_rules_key_idx').on(t.rulesKey),
    index('media_files_last_job_idx').on(t.lastJobId),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').$type<JobType>().notNull(),
    state: text('state').$type<JobState>().notNull().default('queued'),
    step: text('step').$type<JobStep>().notNull().default('waiting'),
    priority: integer('priority').notNull().default(0),
    trigger: text('trigger').$type<JobTrigger>().notNull(),
    mediaFileId: integer('media_file_id').references(() => mediaFiles.id, {
      onDelete: 'set null',
    }),
    libraryId: integer('library_id').references(() => libraries.id, {
      onDelete: 'set null',
    }),
    /** Convert for this profile alone; null = the strictest combination of the library's profiles. */
    profileId: integer('profile_id').references(() => deviceProfiles.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    sourcePath: text('source_path').notNull(),
    outputPath: text('output_path'),
    /** Temp file (audio) or temp directory (bdmv) of a running job; set before writing, cleared after the final rename. */
    tempPath: text('temp_path'),
    rulesKey: text('rules_key'),
    plan: json<ConversionPlan>('plan'),
    bdmvPlan: json<BdmvJobPlan>('bdmv_plan'),
    beforeStreams: json<MediaStream[]>('before_streams'),
    afterStreams: json<MediaStream[]>('after_streams'),
    lostFeatures: json<string[]>('lost_features').notNull().default([]),
    verification: json<VerificationResult>('verification'),
    progress: real('progress').notNull().default(0),
    speed: real('speed'),
    etaSec: real('eta_sec'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    logPath: text('log_path'),
    bytesBefore: integer('bytes_before'),
    bytesAfter: integer('bytes_after'),
    recycleBinEntryId: integer('recycle_bin_entry_id'),
    createdAt: createdAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_state_idx').on(t.state, t.priority, t.id),
    index('jobs_media_file_idx').on(t.mediaFileId),
    index('jobs_finished_idx').on(t.state, t.finishedAt),
  ],
);

export const jobHistory = sqliteTable(
  'job_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id').references(() => jobs.id, {
      onDelete: 'set null',
    }),
    mediaFileId: integer('media_file_id').references(() => mediaFiles.id, {
      onDelete: 'set null',
    }),
    event: text('event').$type<HistoryEventType>().notNull(),
    path: text('path').notNull(),
    message: text('message').notNull(),
    data: json<HistoryData>('data'),
    createdAt: createdAt(),
  },
  (t) => [
    index('job_history_created_idx').on(t.createdAt),
    index('job_history_job_idx').on(t.jobId),
    index('job_history_media_file_idx').on(t.mediaFileId),
  ],
);

export const recycleBin = sqliteTable(
  'recycle_bin',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    originalPath: text('original_path').notNull(),
    recyclePath: text('recycle_path').notNull().unique(),
    sizeBytes: integer('size_bytes').notNull(),
    uid: integer('uid'),
    gid: integer('gid'),
    mode: integer('mode'),
    jobId: integer('job_id').references(() => jobs.id, {
      onDelete: 'set null',
    }),
    mediaFileId: integer('media_file_id').references(() => mediaFiles.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    expiresAt: text('expires_at').notNull(),
    restoredAt: text('restored_at'),
    purgedAt: text('purged_at'),
  },
  (t) => [
    index('recycle_bin_expires_idx').on(t.expiresAt),
    index('recycle_bin_job_idx').on(t.jobId),
    index('recycle_bin_media_file_idx').on(t.mediaFileId),
  ],
);

/** Singleton row (id = 1). */
export const plexConnection = sqliteTable('plex_connection', {
  id: integer('id').primaryKey(),
  /** X-Plex-Client-Identifier of this Wololo install, generated once. */
  clientIdentifier: text('client_identifier').notNull(),
  accountToken: text('account_token'),
  username: text('username'),
  serverMachineId: text('server_machine_id'),
  serverName: text('server_name'),
  serverUrl: text('server_url'),
  serverToken: text('server_token'),
  enabled: bool('enabled').notNull().default(false),
  partialScan: bool('partial_scan').notNull().default(true),
  pauseWhileStreaming: bool('pause_while_streaming').notNull().default(false),
  pendingPinId: integer('pending_pin_id'),
  updatedAt: updatedAt(),
});

/** Singleton row (id = 1). */
export const downloadClient = sqliteTable('download_client', {
  id: integer('id').primaryKey(),
  kind: text('kind').$type<'qbittorrent'>().notNull().default('qbittorrent'),
  enabled: bool('enabled').notNull().default(true),
  url: text('url').notNull(),
  username: text('username').notNull().default(''),
  password: text('password').notNull().default(''),
  removeWhenGoalMet: bool('remove_when_goal_met').notNull().default(false),
  category: text('category'),
  updatedAt: updatedAt(),
});

export const pathMappings = sqliteTable('path_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').$type<PathMappingScope>().notNull(),
  instanceId: integer('instance_id').references(() => arrInstances.id, {
    onDelete: 'cascade',
  }),
  remotePath: text('remote_path').notNull(),
  localPath: text('local_path').notNull(),
});

export const bdmvDecisions = sqliteTable(
  'bdmv_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<BdmvDecisionKind>().notNull(),
    state: text('state').$type<BdmvDecisionState>().notNull().default('pending'),
    message: text('message').notNull(),
    titleCandidates: json<BdmvTitleCandidate[]>('title_candidates').notNull().default([]),
    movieCandidates: json<MovieMatchCandidate[]>('movie_candidates').notNull().default([]),
    choice: json<BdmvDecisionChoice>('choice'),
    createdAt: createdAt(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('bdmv_decisions_state_idx').on(t.state), index('bdmv_decisions_media_idx').on(t.mediaFileId)],
);

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  name: text('name').$type<TaskName>().primaryKey(),
  intervalMinutes: integer('interval_minutes').notNull(),
  enabled: bool('enabled').notNull().default(true),
  lastRunAt: text('last_run_at'),
  lastDurationMs: integer('last_duration_ms'),
  lastResult: text('last_result').$type<'success' | 'failure'>(),
  lastMessage: text('last_message'),
  nextRunAt: text('next_run_at'),
});

export type SettingRow = typeof settings.$inferSelect;
export type ArrInstanceRow = typeof arrInstances.$inferSelect;
export type DeviceProfileRow = typeof deviceProfiles.$inferSelect;
export type LibraryRow = typeof libraries.$inferSelect;
export type LibraryRootRow = typeof libraryRoots.$inferSelect;
export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type NewMediaFileRow = typeof mediaFiles.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobHistoryRow = typeof jobHistory.$inferSelect;
export type RecycleBinRow = typeof recycleBin.$inferSelect;
export type PlexConnectionRow = typeof plexConnection.$inferSelect;
export type DownloadClientRow = typeof downloadClient.$inferSelect;
export type PathMappingRow = typeof pathMappings.$inferSelect;
export type BdmvDecisionRow = typeof bdmvDecisions.$inferSelect;
export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
