import type { AppContext } from '../../app/context.ts';
import type { SystemService } from '../../contracts/platform.ts';
import { notImplemented } from '../../core/errors.ts';

export function createSystemService(_ctx: AppContext): SystemService {
  return {
    status: async () => notImplemented('system.status'),
    health: async () => notImplemented('system.health'),
    tools: async () => notImplemented('system.tools'),
    listBackups: async () => notImplemented('system.listBackups'),
    createBackup: async () => notImplemented('system.createBackup'),
    backupPath: async () => notImplemented('system.backupPath'),
    deleteBackup: async () => notImplemented('system.deleteBackup'),
    restoreBackup: async () => notImplemented('system.restoreBackup'),
    restoreUpload: async () => notImplemented('system.restoreUpload'),
    cleanupLogs: async () => notImplemented('system.cleanupLogs'),
    openApiDocument: () => notImplemented('system.openApiDocument'),
    restart: async () => notImplemented('system.restart'),
  };
}
