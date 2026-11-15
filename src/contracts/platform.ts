/**
 * Contract: platform module (src/modules/system, Dockerfile, docker/, .github/, README.md).
 * Owns: backups under <config>/backups, OpenAPI document, system status and health checks.
 */
import type { BackupInfo, HealthCheck, RestoreResult, SystemStatus, ToolInfo } from '../shared/api-types.ts';

export interface SystemService {
  status(): Promise<SystemStatus>;
  health(): Promise<HealthCheck[]>;
  /** ffmpeg, ffprobe, mkvmerge, 7z (paths from config.tools), nice, ionice: path + version, missing ones flagged in health(). */
  tools(): Promise<ToolInfo[]>;
  listBackups(): Promise<BackupInfo[]>;
  /** Zip of a consistent SQLite snapshot (VACUUM INTO) + config.json, named "wololo_backup_<kind>_<yyyy.MM.dd_HH.mm.ss>.zip". */
  createBackup(kind: BackupInfo['kind']): Promise<BackupInfo>;
  /** Absolute path of a stored backup; AppError('not_found') when missing or the name escapes the backup dir. */
  backupPath(name: string): Promise<string>;
  deleteBackup(name: string): Promise<void>;
  /** Validates the zip, takes a pre_restore backup, stages the files; applied on next start. */
  restoreBackup(name: string): Promise<RestoreResult>;
  restoreUpload(bytes: Uint8Array): Promise<RestoreResult>;
  /** Removes job logs older than 30 days whose job no longer exists. */
  cleanupLogs(): Promise<string>;
  /**
   * OpenAPI 3.1 from API_ROUTE_META (paths, methods, auth, summaries, response type names) plus the zod schemas handlers
   * register through route(app, key, handler, { body, query, params }) (routeSchemas() in src/api/http.ts, z.toJSONSchema).
   * Response bodies are described by their TypeScript type name only.
   */
  openApiDocument(): Record<string, unknown>;
  /** Answers first, then ctx.requestRestart() (graceful stop + exit 0; the container restart policy brings Wololo back). */
  restart(): Promise<void>;
}
