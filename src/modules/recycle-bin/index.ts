import type { AppContext } from '../../app/context.ts';
import type { RecycleBinService } from '../../contracts/jobs.ts';
import { notImplemented } from '../../core/errors.ts';

export function createRecycleBinService(_ctx: AppContext): RecycleBinService {
  return {
    list: async () => notImplemented('recycleBin.list'),
    recycle: async () => notImplemented('recycleBin.recycle'),
    restore: async () => notImplemented('recycleBin.restore'),
    remove: async () => notImplemented('recycleBin.remove'),
    purge: async () => notImplemented('recycleBin.purge'),
  };
}
