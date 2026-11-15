/**
 * Contract: integrations module (src/modules/integrations).
 * Owns writes to: arr_instances, plex_connection, download_client, path_mappings.
 * All HTTP calls use fetch with a timeout (default 15 s) and throw AppError('upstream') on failure.
 */
import type {
  ArrInstanceInput,
  ArrRootFolder,
  ArrTestRequest,
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
  MovieMatchCandidate,
  PathMapping,
  PathMappingScope,
  PlexConnection,
  PlexSection,
  PlexServer,
  TorrentInfo,
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
  /** Radarr GET /api/v3/movie/lookup?term=; score is computed locally (title + year similarity). */
  lookupMovie(
    instanceId: number,
    term: string,
    year?: number | null,
  ): Promise<MovieMatchCandidate[]>;
  /** Finds the movie/series owning a local path (via path mappings + GET /api/v3/movie or /series). */
  findByPath(
    localPath: string,
  ): Promise<{ ref: ArrItemRef; originalLanguage: string | null } | null>;
  /** POST /api/v3/command {"name":"RescanMovie","movieId"} or {"name":"RescanSeries","seriesId"}. */
  rescan(ref: ArrItemRef): Promise<void>;
  /** Radarr POST /api/v3/command {"name":"DownloadedMoviesScan","path":<remote path>} so Radarr imports a BDMV output. */
  importMovieFolder(instanceId: number, localPath: string): Promise<void>;
  /** First enabled Radarr instance, used by BDMV when the library has none assigned. */
  defaultRadarr(): Promise<ArrInstance | null>;
}

export interface WebhookService {
  /** Test -> ack; Download (incl. isUpgrade) -> map path -> media.checkPath; other events ignored. Never throws for bad payloads. */
  handleRadarr(payload: RadarrWebhookPayload): Promise<WebhookResponse>;
  handleSonarr(payload: SonarrWebhookPayload): Promise<WebhookResponse>;
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
  /** GET {server}/library/sections/{key}/refresh?path=<plex path>; section found by matching Location paths. No-op when disabled. */
  refreshPath(localPath: string): Promise<void>;
  /** GET {server}/status/sessions; 0 when Plex is not configured or unreachable. */
  sessions(): Promise<PlexSessions>;
}

export interface DownloadClientService {
  get(): Promise<DownloadClientConnection | null>;
  save(input: DownloadClientInput): Promise<DownloadClientConnection>;
  remove(): Promise<void>;
  test(input: DownloadClientInput): Promise<ConnectionTestResult>;
  /** qBittorrent Web API v2 /api/v2/torrents/info; matches content_path / save_path after path mapping. Null when not configured. */
  findTorrentByPath(localPath: string): Promise<TorrentInfo | null>;
  /** /api/v2/torrents/delete?hashes=&deleteFiles=true */
  deleteTorrent(hash: string, deleteFiles: boolean): Promise<void>;
  /** Scheduled task: removes torrents whose goal is met and whose media was replaced (only when removeWhenGoalMet). */
  checkSeedingGoals(): Promise<string>;
}

export interface PathMappingService {
  list(): Promise<PathMapping[]>;
  create(input: PathMappingInput): Promise<PathMapping>;
  update(id: number, input: PathMappingInput): Promise<PathMapping>;
  remove(id: number): Promise<void>;
  /** Remote app path -> local path (longest remotePath prefix wins); unchanged when no mapping matches. */
  toLocal(
    scope: PathMappingScope,
    remotePath: string,
    instanceId?: number | null,
  ): Promise<string>;
  /** Local path -> remote app path. */
  toRemote(
    scope: PathMappingScope,
    localPath: string,
    instanceId?: number | null,
  ): Promise<string>;
}

/** Pure path translation used by PathMappingService, table-tested (trailing slashes, longest prefix, no partial segment match). */
export type MapPath = (
  path: string,
  mappings: readonly { from: string; to: string }[],
) => string;

export interface FileChangedEvent {
  kind: 'replaced' | 'created';
  localPath: string;
  mediaFileId: number | null;
  arr: ArrItemRef | null;
  jobId: number | null;
}

export interface NotifierService {
  /** Arr rescan (or import for BDMV output) then Plex partial scan of the folder. Errors are logged, never thrown. */
  fileChanged(event: FileChangedEvent): Promise<void>;
}
