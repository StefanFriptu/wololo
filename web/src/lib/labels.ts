import type {
  BdmvDecisionKind,
  DroppedStream,
  HistoryEventType,
  JobState,
  JobStep,
  JobTrigger,
  LibraryKind,
  LibraryMode,
  LogLevel,
  MediaFileKind,
  MediaFileStatus,
  PathMappingScope,
  PlanAction,
  QueuePauseReason,
  VerificationCheck,
} from '#lib/shared.ts';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const MEDIA_STATUS_LABELS: Readonly<Record<MediaFileStatus, string>> = {
  pending: 'Pending',
  compatible: 'Compatible',
  needs_work: 'Needs work',
  processing: 'Processing',
  failed: 'Failed',
  ignored: 'Ignored',
};

export const MEDIA_STATUS_TONES: Readonly<Record<MediaFileStatus, Tone>> = {
  pending: 'neutral',
  compatible: 'success',
  needs_work: 'warning',
  processing: 'info',
  failed: 'danger',
  ignored: 'neutral',
};

export const MEDIA_KIND_LABELS: Readonly<Record<MediaFileKind, string>> = {
  file: 'File',
  bdmv: 'Blu-ray folder',
  iso: 'Blu-ray ISO',
};

export const JOB_STATE_LABELS: Readonly<Record<JobState, string>> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const JOB_STATE_TONES: Readonly<Record<JobState, Tone>> = {
  queued: 'neutral',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export const JOB_STEP_LABELS: Readonly<Record<JobStep, string>> = {
  waiting: 'Waiting',
  preparing: 'Preparing',
  encoding: 'Encoding',
  muxing: 'Muxing',
  verifying: 'Verifying',
  replacing: 'Replacing',
  importing: 'Importing',
  notifying: 'Notifying',
  done: 'Done',
};

export const JOB_TRIGGER_LABELS: Readonly<Record<JobTrigger, string>> = {
  webhook: 'Import',
  scan: 'Scan',
  manual: 'Manual',
  retry: 'Retry',
  recovery: 'Recovery',
};

export const PLAN_ACTION_LABELS: Readonly<Record<PlanAction, string>> = {
  skip: 'Nothing to do',
  remux: 'Remux',
  convert: 'Convert',
  blocked: 'Blocked',
};

export const PLAN_ACTION_TONES: Readonly<Record<PlanAction, Tone>> = {
  skip: 'success',
  remux: 'info',
  convert: 'warning',
  blocked: 'danger',
};

export const DROP_REASON_LABELS: Readonly<Record<DroppedStream['reason'], string>> = {
  incompatible_replaced: 'Replaced by the converted track',
  compatible_duplicate: 'Compatible track in the same language exists',
  language_filter: 'Language not in the keep-list',
  unsupported: 'Unsupported by the profile',
};

export const HISTORY_EVENT_LABELS: Readonly<Record<HistoryEventType, string>> = {
  queued: 'Queued',
  started: 'Started',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  retried: 'Retried',
  skipped: 'Skipped',
  recycled: 'Recycled',
  restored: 'Restored',
  purged: 'Purged',
  imported: 'Imported',
  source_deleted: 'Source deleted',
};

export const HISTORY_EVENT_TONES: Readonly<Record<HistoryEventType, Tone>> = {
  queued: 'neutral',
  started: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  retried: 'info',
  skipped: 'neutral',
  recycled: 'neutral',
  restored: 'warning',
  purged: 'neutral',
  imported: 'success',
  source_deleted: 'warning',
};

export const PAUSE_REASON_LABELS: Readonly<Record<QueuePauseReason, string>> = {
  user: 'Paused by you',
  window: 'Outside the processing window',
  plex_streaming: 'Plex is streaming',
  shutdown: 'Shutting down',
};

export const VERIFICATION_LABELS: Readonly<Record<VerificationCheck['name'], string>> = {
  duration: 'Duration',
  stream_count: 'Stream count',
  video_checksum: 'Video checksum',
  video_packets: 'Video packets',
  audio_decode: 'Audio decode',
  chapters: 'Chapters',
  languages: 'Languages',
  free_space: 'Free space',
  output_exists: 'Output exists',
};

export const LIBRARY_KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  movies: 'Movies',
  series: 'Series',
  other: 'Other',
};

export const LIBRARY_MODE_LABELS: Readonly<Record<LibraryMode, string>> = {
  replace: 'Replace',
  keep_both: 'Keep both',
};

export const DECISION_KIND_LABELS: Readonly<Record<BdmvDecisionKind, string>> = {
  main_title: 'Main title',
  movie_match: 'Movie match',
  delete_source: 'Delete source',
};

export const PATH_SCOPE_LABELS: Readonly<Record<PathMappingScope, string>> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  plex: 'Plex',
  qbittorrent: 'qBittorrent',
};

export const LOG_LEVEL_TONES: Readonly<Record<LogLevel, Tone>> = {
  trace: 'neutral',
  debug: 'neutral',
  info: 'info',
  warn: 'warning',
  error: 'danger',
};
