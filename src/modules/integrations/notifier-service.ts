import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { FileChangedEvent, NotifierService } from '../../contracts/integrations.ts';
import type { ArrItemRef } from '../../shared/domain.ts';

async function folderOf(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ? path : dirname(path);
}

export function createNotifierService(ctx: AppContext): NotifierService {
  const log = ctx.logs.logger('notifier');

  const resolveRef = async (event: FileChangedEvent): Promise<ArrItemRef | null> => {
    if (event.arr) return event.arr;
    const found = await ctx.services.arr.findByPath(event.localPath);
    return found?.ref ?? null;
  };

  const rescanArr = async (event: FileChangedEvent) => {
    try {
      const ref = await resolveRef(event);
      if (!ref) {
        log.warn('no Radarr/Sonarr item owns this file; skipping the rescan', {
          path: event.localPath,
          jobId: event.jobId,
        });
        return;
      }
      await ctx.services.arr.rescan(ref);
    } catch (error) {
      log.error('arr rescan failed', { path: event.localPath, jobId: event.jobId, error });
    }
  };

  const refreshPlex = async (event: FileChangedEvent) => {
    try {
      await ctx.services.plex.refreshPath(await folderOf(event.localPath));
    } catch (error) {
      log.error('Plex partial scan failed', { path: event.localPath, jobId: event.jobId, error });
    }
  };

  return {
    fileChanged: async (event) => {
      const notifications = ctx.settings.section('notifications');
      if (event.kind === 'replaced' && notifications.rescanArr) await rescanArr(event);
      if (notifications.plexPartialScan) await refreshPlex(event);
    },
  };
}
