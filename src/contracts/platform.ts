/**
 * Contract: platform module (src/modules/system, Dockerfile, docker/, .github/, README.md).
 * Owns: backups under <config>/backups, OpenAPI document, system status and health checks.
 */
import type {
  BackupInfo,
  HealthCheck,
  RestoreResult,
  SystemStatus,
  ToolInfo,
} from '../shared/api-types.ts';

export interface SystemService {
  status(): Promise<SystemStatus>;
  health(): Promise<HealthCheck[]>;
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
  openApiDocument(): Record<string, unknown>;
  /** Graceful shutdown then process exit; the container restart policy brings Wololo back. */
  restart(): Promise<void>;
}
