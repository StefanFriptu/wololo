import type { AppContext } from '../../app/context.ts';
import type { ProfileService } from '../../contracts/rules-ffmpeg.ts';
import { notImplemented } from '../../core/errors.ts';

export function createProfileService(_ctx: AppContext): ProfileService {
  return {
    list: async () => notImplemented('profiles.list'),
    get: async () => notImplemented('profiles.get'),
    create: async () => notImplemented('profiles.create'),
    update: async () => notImplemented('profiles.update'),
    remove: async () => notImplemented('profiles.remove'),
    clone: async () => notImplemented('profiles.clone'),
    ensureDefaults: async () => {},
    getDefault: async () => notImplemented('profiles.getDefault'),
    codecCatalog: () => notImplemented('profiles.codecCatalog'),
  };
}
