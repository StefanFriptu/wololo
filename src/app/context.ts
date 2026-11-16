import type { BdmvService } from '../contracts/bdmv.ts';
import type {
  ArrService,
  DownloadClientService,
  NotifierService,
  PathMappingService,
  PlexService,
  WebhookService,
} from '../contracts/integrations.ts';
import type { JobsService, RecycleBinService } from '../contracts/jobs.ts';
import type { SystemService } from '../contracts/platform.ts';
import type {
  DryRunService,
  LibraryService,
  MediaService,
  ProbeService,
  ScanService,
  SchedulerService,
} from '../contracts/probe-scan.ts';
import type { FfmpegService, ProfileService, RulesService } from '../contracts/rules-ffmpeg.ts';
import type { ConfigStore } from '../core/config.ts';
import { EventBus } from '../core/events.ts';
import type { Logger, LogHub } from '../core/logger.ts';
import { SettingsStore } from '../core/settings.ts';
import type { Db, DbHandle } from '../db/client.ts';
import { createBdmvService } from '../modules/bdmv/index.ts';
import { createFfmpegService } from '../modules/ffmpeg/index.ts';
import {
  createArrService,
  createDownloadClientService,
  createNotifierService,
  createPathMappingService,
  createPlexService,
  createWebhookService,
} from '../modules/integrations/index.ts';
import { createJobsService } from '../modules/jobs/index.ts';
import { createProbeService } from '../modules/probe/index.ts';
import { createProfileService } from '../modules/profiles/index.ts';
import { createRecycleBinService } from '../modules/recycle-bin/index.ts';
import { createRulesService } from '../modules/rules/index.ts';
import {
  createDryRunService,
  createLibraryService,
  createMediaService,
  createScanService,
} from '../modules/scan/index.ts';
import { createSchedulerService } from '../modules/scheduler/index.ts';
import { createSystemService } from '../modules/system/index.ts';

/** Every cross-module call goes through one of these, typed by src/contracts/*. */
export interface Services {
  probe: ProbeService;
  libraries: LibraryService;
  media: MediaService;
  scan: ScanService;
  dryRun: DryRunService;
  scheduler: SchedulerService;
  profiles: ProfileService;
  rules: RulesService;
  ffmpeg: FfmpegService;
  jobs: JobsService;
  recycleBin: RecycleBinService;
  arr: ArrService;
  webhooks: WebhookService;
  plex: PlexService;
  downloadClient: DownloadClientService;
  pathMappings: PathMappingService;
  notifier: NotifierService;
  bdmv: BdmvService;
  system: SystemService;
}

/**
 * The explicit dependency container. Factories receive it and must not call other services while
 * constructing (services are wired in one pass); resolve them lazily via ctx.services.<name> at call time.
 */
export interface AppContext {
  config: ConfigStore;
  logs: LogHub;
  log: Logger;
  dbHandle: DbHandle;
  db: Db;
  events: EventBus;
  settings: SettingsStore;
  services: Services;
  startedAt: Date;
  /** Aborted when shutdown starts; long-running loops should watch it. */
  shutdownSignal: AbortSignal;
  requestShutdown(): void;
  /** Graceful stop, then process exit 0 so the container restart policy starts Wololo again (system.restart). */
  requestRestart(): void;
}

export type ServiceFactory<T> = (ctx: AppContext) => T;

export interface CreateContextOptions {
  config: ConfigStore;
  logs: LogHub;
  dbHandle: DbHandle;
  /** Replace individual services (tests). */
  overrides?: Partial<Services>;
  /** Wired by bootstrap to stop + exit; tests pass a recorder. Default: logs a warning and does nothing. */
  requestRestart?: () => void;
}

export function createAppContext(options: CreateContextOptions): AppContext {
  const log = options.logs.logger('app');
  const events = new EventBus((error, name) => log.error('event listener failed', { event: name, error }));
  options.logs.onEntry((entry) => {
    if (events.listenerCount() > 0) events.emit('log.entry', entry);
  });
  const shutdown = new AbortController();

  const ctx: AppContext = {
    config: options.config,
    logs: options.logs,
    log,
    dbHandle: options.dbHandle,
    db: options.dbHandle.db,
    events,
    settings: new SettingsStore(options.dbHandle.db, events, log),
    services: {} as Services,
    startedAt: new Date(),
    shutdownSignal: shutdown.signal,
    requestShutdown: () => shutdown.abort(),
    requestRestart: options.requestRestart ?? (() => log.warn('restart requested but no restart handler is wired')),
  };

  const services: Services = {
    probe: createProbeService(ctx),
    libraries: createLibraryService(ctx),
    media: createMediaService(ctx),
    scan: createScanService(ctx),
    dryRun: createDryRunService(ctx),
    scheduler: createSchedulerService(ctx),
    profiles: createProfileService(ctx),
    rules: createRulesService(ctx),
    ffmpeg: createFfmpegService(ctx),
    jobs: createJobsService(ctx),
    recycleBin: createRecycleBinService(ctx),
    arr: createArrService(ctx),
    webhooks: createWebhookService(ctx),
    plex: createPlexService(ctx),
    downloadClient: createDownloadClientService(ctx),
    pathMappings: createPathMappingService(ctx),
    notifier: createNotifierService(ctx),
    bdmv: createBdmvService(ctx),
    system: createSystemService(ctx),
    ...options.overrides,
  };
  Object.assign(ctx.services, services);
  return ctx;
}
