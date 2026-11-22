/**
 * Contract: integrations module (src/modules/integrations).
 * Owns writes to: arr_instances, plex_connection, download_client, path_mappings, torrent_removals.
 * All HTTP calls use fetch with a timeout (default 15 s) and throw AppError('upstream') on failure.
 */
import type {
  ArrInstanceInput,
  ArrPathCheck,
  ArrQualityProfile,
  ArrRootFolder,
  ArrTestRequest,
  ArrWebhookStatus,
  ArrWebhookTest,
  ConnectionTestResult,
  DownloadClientInput,
  PathMappingInput,
  PlexConnectionUpdate,
  PlexPin,
  PlexPinStatus,
  PlexSessions,
  RadarrWebhookPayload,
  SonarrWebhookPayload,
  WebhookResponse,
} from '../shared/api-types.ts';
import type {
  ArrInstance,
  ArrItemRef,
  DownloadClientConnection,
  MediaTorrent,
  MovieMatchCandidate,
  PathMapping,
  PathMappingScope,
  PlexConnection,
  PlexSection,
  PlexServer,
  TorrentInfo,
  TorrentRemoval,
  TorrentRemovalCondition,
} from '../shared/domain.ts';

export interface ArrService {
  list(): Promise<ArrInstance[]>;
  get(id: number): Promise<ArrInstance>;
  create(input: ArrInstanceInput): Promise<ArrInstance>;
  update(id: number, input: ArrInstanceInput): Promise<ArrInstance>;
  remove(id: number): Promise<void>;
  /** GET /api/v3/system/status. */
  test(input: ArrTestRequest): Promise<ConnectionTestResult>;
  /** GET /api/v3/rootfolder, with local paths resolved through path mappings. */
  rootFolders(id: number): Promise<ArrRootFolder[]>;
  /** GET /api/v3/qualityprofile. */
  qualityProfiles(id: number): Promise<ArrQualityProfile[]>;
  /**
   * Radarr GET /api/v3/movie/lookup?term=; score is computed locally (title + year similarity).
   * Also serves GET /api/v1/arr/:id/lookup (manual search in the movie_match decision); term "tmdb:<id>" resolves one id.
   */
  lookupMovie(instanceId: number, term: string, year?: number | null): Promise<MovieMatchCandidate[]>;
  /**
   * Radarr POST /api/v3/movie for a BDMV movie Radarr does not know yet (MovieMatchCandidate.radarrMovieId null):
   * monitored true, addOptions.searchForMovie false, rootFolderPath translated to the remote path. Returns the movie id.
   */
  addMovie(
    instanceId: number,
    movie: {
      tmdbId: number;
      title: string;
      year: number | null;
      rootFolderPath: string;
      qualityProfileId: number | null;
    },
  ): Promise<number>;
  /**
   * Finds the movie/series owning a local path (via path mappings + GET /api/v3/movie or /series).
   * originalLanguage is normalised with normalizeLanguage (Radarr/Sonarr send names such as "English").
   */
  findByPath(localPath: string): Promise<{ ref: ArrItemRef; originalLanguage: string | null } | null>;
  /** POST /api/v3/command {"name":"RescanMovie","movieId"} or {"name":"RescanSeries","seriesId"}. */
  rescan(ref: ArrItemRef): Promise<void>;
  /**
   * Makes Radarr import a BDMV output folder. Radarr refuses DownloadedMoviesScan on a folder that is a movie's own
   * path, so when the folder is movie movieId's path this sends RescanMovie instead; otherwise POST /api/v3/command
   * {"name":"DownloadedMoviesScan","path":<remote path>} and Radarr moves the file into the movie's folder.
   */
  importMovieFolder(instanceId: number, localPath: string, movieId: number): Promise<void>;
  /** First enabled Radarr instance, used by BDMV when the library has none assigned. */
  defaultRadarr(): Promise<ArrInstance | null>;
  /** GET /api/v3/notification: the Webhook whose URL is Wololo's webhook path with ?instance=<id>. */
  webhook(id: number): Promise<ArrWebhookStatus>;
  /** Creates (from GET /api/v3/notification/schema) or updates that Webhook to POST webhookUrl on import and upgrade. */
  ensureWebhook(id: number, address: string): Promise<ArrWebhookStatus>;
  /** POST /api/v3/notification/test on that Webhook. */
  testWebhook(id: number): Promise<ArrWebhookTest>;
  /** Maps one real Radarr/Sonarr file to a local path; suggests a mapping under a library root when it is missing. */
  checkPaths(id: number): Promise<ArrPathCheck>;
}

/**
 * instanceId comes from the webhook URL (?instance=<id>); null -> resolved as documented on WebhookQuery
 * (only enabled instance of the kind, then payload.instanceName = ArrInstance.name, then applicationUrl = url).
 * Test -> ack; Download (incl. isUpgrade) -> pathMappings.toLocal(kind, path, instanceId) -> media.checkPath with
 * arr ref + normalizeLanguage(originalLanguage.name); other events ignored. Never throws for bad payloads.
 */
export interface WebhookService {
  handleRadarr(payload: RadarrWebhookPayload, instanceId: number | null): Promise<WebhookResponse>;
  handleSonarr(payload: SonarrWebhookPayload, instanceId: number | null): Promise<WebhookResponse>;
}

export interface PlexService {
  connection(): Promise<PlexConnection>;
  update(patch: PlexConnectionUpdate): Promise<PlexConnection>;
  signOut(): Promise<PlexConnection>;
  /** POST https://plex.tv/api/v2/pins?strong=true with X-Plex-Product=Wololo and the stored client identifier. */
  createPin(): Promise<PlexPin>;
  /** GET https://plex.tv/api/v2/pins/{id}; stores the account token once authenticated. */
  checkPin(id: number): Promise<PlexPinStatus>;
  /** GET https://plex.tv/api/v2/resources?includeHttps=1 filtered to servers. */
  servers(): Promise<PlexServer[]>;
  /** GET {server}/library/sections (Accept: application/json). */
  sections(): Promise<PlexSection[]>;
  test(): Promise<ConnectionTestResult>;
  /**
   * GET {server}/library/sections/{key}/refresh?path=<plex path>; section found by matching Location paths. No-op when
   * the connection is disabled or PlexConnection.partialScan is off.
   */
  refreshPath(localPath: string): Promise<void>;
  /** GET {server}/status/sessions; 0 when Plex is not configured or unreachable. */
  sessions(): Promise<PlexSessions>;
}

export interface DownloadClientService {
  get(): Promise<DownloadClientConnection | null>;
  save(input: DownloadClientInput): Promise<DownloadClientConnection>;
  remove(): Promise<void>;
  test(input: DownloadClientInput): Promise<ConnectionTestResult>;
  /**
   * qBittorrent Web API v2 /api/v2/torrents/info; matches content_path / save_path after path mapping. Null when not
   * configured. Every TorrentInfo leaving this service carries local paths (qbittorrent mappings applied).
   */
  findTorrentByPath(localPath: string): Promise<TorrentInfo | null>;
  /** /api/v2/torrents/delete?hashes=&deleteFiles=true */
  deleteTorrent(hash: string, deleteFiles: boolean): Promise<void>;
  /**
   * Scheduled task (seeding_check). For every torrent whose goal is met:
   * - its content was replaced by an audio job and removeWhenGoalMet -> deleteTorrent(hash, true);
   * - its content is a converted disc (completed bdmv job) and settings.bdmv.deleteSourceWhenSeeded ->
   *   bdmv.offerSourceDeletion(mediaFileId, torrent) with local paths (the user confirms in the UI; nothing is deleted
   *   here).
   */
  checkSeedingGoals(): Promise<string>;
  /**
   * The torrent a library file was imported from: the Radarr/Sonarr item history (GET /api/v3/history/movie or
   * history/series) names the download hash for the file's path (or the source path of its completed audio job), matched
   * against qBittorrent. Null without a client, a Radarr/Sonarr item, or a matching torrent.
   */
  torrentForMedia(mediaFileId: number): Promise<MediaTorrent | null>;
  /** Saves (or restarts) the removal request of the file's torrent, keyed by hash; not_found when it has none. */
  requestRemoval(mediaFileId: number, condition: TorrentRemovalCondition): Promise<TorrentRemoval>;
  /** Cancels the pending removal request of the file's torrent; no-op when there is none. */
  cancelRemoval(mediaFileId: number): Promise<void>;
  /**
   * Pending removal requests, after each completed audio job and in seeding_check (one run at a time): cancelled when a
   * file of the torrent was restored since the request; kept while any torrent file is a library file, while
   * torrentConversionProgress is not allConverted, or (converted_and_seeded) before goalMet; otherwise
   * deleteTorrent(hash, true). A torrent gone from qBittorrent ends as missing.
   */
  processRemovals(): Promise<string>;
}

export interface PathMappingService {
  list(): Promise<PathMapping[]>;
  create(input: PathMappingInput): Promise<PathMapping>;
  update(id: number, input: PathMappingInput): Promise<PathMapping>;
  remove(id: number): Promise<void>;
  /** Remote app path -> local path (longest remotePath prefix wins); unchanged when no mapping matches. */
  toLocal(scope: PathMappingScope, remotePath: string, instanceId?: number | null): Promise<string>;
  /** Local path -> remote app path. */
  toRemote(scope: PathMappingScope, localPath: string, instanceId?: number | null): Promise<string>;
}

/** Pure path translation used by PathMappingService, table-tested (trailing slashes, longest prefix, no partial segment match). */
export type MapPath = (path: string, mappings: readonly { from: string; to: string }[]) => string;

export interface FileChangedEvent {
  kind: 'replaced' | 'created';
  localPath: string;
  mediaFileId: number | null;
  arr: ArrItemRef | null;
  jobId: number | null;
}

export interface NotifierService {
  /**
   * replaced: arr.rescan(ref) (ref = event.arr, else arr.findByPath(localPath); still unresolved -> warning, no rescan),
   * then plex.refreshPath(folder). created (BDMV output, already imported by bdmv): plex.refreshPath only.
   * Honours settings.notifications.rescanArr; plex.refreshPath honours PlexConnection.partialScan. Errors are logged,
   * never thrown; transient upstream failures (network, 429, 5xx) are retried in the background after it resolves.
   */
  fileChanged(event: FileChangedEvent): Promise<void>;
}
