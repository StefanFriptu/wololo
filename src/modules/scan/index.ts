import type { AppContext } from '../../app/context.ts';
import type { DryRunService, LibraryService, MediaService, ScanService } from '../../contracts/probe-scan.ts';
import { notImplemented } from '../../core/errors.ts';

export function createLibraryService(_ctx: AppContext): LibraryService {
  return {
    list: async () => notImplemented('libraries.list'),
    get: async () => notImplemented('libraries.get'),
    create: async () => notImplemented('libraries.create'),
    update: async () => notImplemented('libraries.update'),
    remove: async () => notImplemented('libraries.remove'),
    findRootForPath: async () => notImplemented('libraries.findRootForPath'),
    browse: async () => notImplemented('libraries.browse'),
  };
}

export function createMediaService(_ctx: AppContext): MediaService {
  return {
    list: async () => notImplemented('media.list'),
    get: async () => notImplemented('media.get'),
    stats: async () => notImplemented('media.stats'),
    findByPath: async () => notImplemented('media.findByPath'),
    checkPath: async () => notImplemented('media.checkPath'),
    reprobe: async () => notImplemented('media.reprobe'),
    previewPlan: async () => notImplemented('media.previewPlan'),
    setIgnored: async () => notImplemented('media.setIgnored'),
    setStatus: async () => notImplemented('media.setStatus'),
    recordJobResult: async () => notImplemented('media.recordJobResult'),
    invalidateRules: async () => notImplemented('media.invalidateRules'),
  };
}

export function createScanService(_ctx: AppContext): ScanService {
  return {
    start: async () => notImplemented('scan.start'),
    current: () => null,
    cancel: async () => notImplemented('scan.cancel'),
  };
}

export function createDryRunService(_ctx: AppContext): DryRunService {
  return {
    report: async () => notImplemented('dryRun.report'),
  };
}
