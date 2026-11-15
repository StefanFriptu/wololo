import type { AppConfig } from '../../core/config.ts';

/**
 * Called by bootstrap before the database opens. Applies a restore staged by SystemService.restoreBackup
 * (e.g. <config>/restore/ with wololo.db + config.json) and returns true when it did.
 */
export function applyPendingRestore(_config: AppConfig): boolean {
  return false;
}
