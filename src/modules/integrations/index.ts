import type { AppContext } from '../../app/context.ts';
import type {
  ArrService,
  DownloadClientService,
  NotifierService,
  PathMappingService,
  PlexService,
  WebhookService,
} from '../../contracts/integrations.ts';
import { notImplemented } from '../../core/errors.ts';

export function createArrService(_ctx: AppContext): ArrService {
  return {
    list: async () => notImplemented('arr.list'),
    get: async () => notImplemented('arr.get'),
    create: async () => notImplemented('arr.create'),
    update: async () => notImplemented('arr.update'),
    remove: async () => notImplemented('arr.remove'),
    test: async () => notImplemented('arr.test'),
    rootFolders: async () => notImplemented('arr.rootFolders'),
    lookupMovie: async () => notImplemented('arr.lookupMovie'),
    findByPath: async () => notImplemented('arr.findByPath'),
    rescan: async () => notImplemented('arr.rescan'),
    importMovieFolder: async () => notImplemented('arr.importMovieFolder'),
    defaultRadarr: async () => notImplemented('arr.defaultRadarr'),
  };
}

export function createWebhookService(_ctx: AppContext): WebhookService {
  return {
    handleRadarr: async () => notImplemented('webhooks.handleRadarr'),
    handleSonarr: async () => notImplemented('webhooks.handleSonarr'),
  };
}

export function createPlexService(_ctx: AppContext): PlexService {
  return {
    connection: async () => notImplemented('plex.connection'),
    update: async () => notImplemented('plex.update'),
    signOut: async () => notImplemented('plex.signOut'),
    createPin: async () => notImplemented('plex.createPin'),
    checkPin: async () => notImplemented('plex.checkPin'),
    servers: async () => notImplemented('plex.servers'),
    sections: async () => notImplemented('plex.sections'),
    test: async () => notImplemented('plex.test'),
    refreshPath: async () => notImplemented('plex.refreshPath'),
    sessions: async () => notImplemented('plex.sessions'),
  };
}

export function createDownloadClientService(
  _ctx: AppContext,
): DownloadClientService {
  return {
    get: async () => notImplemented('downloadClient.get'),
    save: async () => notImplemented('downloadClient.save'),
    remove: async () => notImplemented('downloadClient.remove'),
    test: async () => notImplemented('downloadClient.test'),
    findTorrentByPath: async () =>
      notImplemented('downloadClient.findTorrentByPath'),
    deleteTorrent: async () => notImplemented('downloadClient.deleteTorrent'),
    checkSeedingGoals: async () =>
      notImplemented('downloadClient.checkSeedingGoals'),
  };
}

export function createPathMappingService(_ctx: AppContext): PathMappingService {
  return {
    list: async () => notImplemented('pathMappings.list'),
    create: async () => notImplemented('pathMappings.create'),
    update: async () => notImplemented('pathMappings.update'),
    remove: async () => notImplemented('pathMappings.remove'),
    toLocal: async () => notImplemented('pathMappings.toLocal'),
    toRemote: async () => notImplemented('pathMappings.toRemote'),
  };
}

export function createNotifierService(_ctx: AppContext): NotifierService {
  return {
    fileChanged: async () => notImplemented('notifier.fileChanged'),
  };
}
