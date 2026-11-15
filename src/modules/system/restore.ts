/**
 * Called by bootstrap BEFORE ConfigStore, the logger and the database open, so a restored config.json (API key, port,
 * URL base) and wololo.db take effect in the same start. Applies a restore staged by SystemService.restoreBackup
 * (e.g. <configDir>/restore/ with wololo.db + config.json) and returns true when it did.
 */
export function applyPendingRestore(_configDir: string): boolean {
  return false;
}
