import type { LogLevel } from './domain.ts';

/**
 * Bootstrap configuration, stored in <configDir>/config.json and overridable by WOLOLO__* env vars.
 * Changes to port, bindAddress or urlBase need a restart (like Radarr's config.xml).
 */
export interface GeneralConfig {
  port: number;
  bindAddress: string;
  /** "" or "/wololo". Applies to the API and static files. */
  urlBase: string;
  apiKey: string;
  logLevel: LogLevel;
  instanceName: string;
  /** Who gets the API key injected into the web UI. The API itself always requires the key. */
  authentication: AuthenticationMode;
}

/**
 * disabled_for_local_addresses (default): the UI gets the key only for requests from loopback/private addresses
 * (RFC 1918, CGNAT, link-local, IPv6 ULA) without X-Forwarded-For/Forwarded headers; everyone else is asked for it.
 * required: the UI always asks for the key (stored in the browser).
 * disabled: every client of the web port gets the key; only behind an authenticating reverse proxy.
 */
export const AUTHENTICATION_MODES = ['disabled_for_local_addresses', 'required', 'disabled'] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

/** Runtime settings, stored in the settings KV table, one row per top-level section. */
export interface Settings {
  processing: {
    /** false = dry-run mode: probe and report only, never write a media file. Default false until the owner opts in. */
    enabled: boolean;
    /** The user's queue pause (POST /api/v1/queue/pause|resume); survives restarts. Default false. */
    paused: boolean;
    /** Jobs that may run at the same time. Default 1. */
    concurrency: number;
    /** nice level for child processes (0-19). Default 10. */
    niceLevel: number;
    /** ionice class for child processes. Default "idle". */
    ioniceClass: 'idle' | 'best-effort';
    window: { enabled: boolean; start: string; end: string };
    /** Multiple of real time used for dry-run time estimates (Pi 4 baseline 7.7). */
    estimatedSpeedFactor: number;
    /** Extra free space required on top of the estimated output size, in percent. Default 5. */
    freeSpaceMarginPercent: number;
    maxAttempts: number;
  };
  media: {
    /** Lower-case extensions (with dot) the scanner considers. */
    extensions: string[];
    /**
     * Glob patterns relative to a root that the scanner skips (e.g. "**\/Sample/**"). Dot-prefixed names (the default
     * recycle bin) and Wololo temp files (TEMP_FILE_MARKER) are always skipped, whatever this list says.
     */
    ignorePatterns: string[];
    /** Scan new or changed files right after a webhook import. */
    checkOnImport: boolean;
  };
  recycleBin: {
    enabled: boolean;
    retentionDays: number;
    /** Absolute path; null = "<root>/.wololo-recycle" on the same filesystem as the original. */
    path: string | null;
  };
  bdmv: {
    enabled: boolean;
    /** Candidates within this percentage of the longest playlist trigger a decision. Default 5. */
    ambiguityPercent: number;
    onAmbiguous: 'ask' | 'editions';
    /** Radarr lookup score below which a decision is required. 0..1, default 0.8. */
    minMatchScore: number;
    extras: { enabled: boolean; minMinutes: number };
    /** Offer to delete the source (delete_source decision) once its torrent's seeding goal is met. */
    deleteSourceWhenSeeded: boolean;
    /** Local path of the Radarr root folder for BDMV output; null = the one holding the disc's library, else the first. */
    rootFolderPath: string | null;
    /** Radarr quality profile for movies BDMV adds to Radarr; null = the instance's first profile. */
    qualityProfileId: number | null;
  };
  /** Plex partial scans are switched on the Plex connection (PlexConnection.partialScan). */
  notifications: {
    rescanArr: boolean;
  };
}

export type SettingsSection = keyof Settings;

export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export const DEFAULT_SETTINGS: Settings = {
  processing: {
    enabled: false,
    paused: false,
    concurrency: 1,
    niceLevel: 10,
    ioniceClass: 'idle',
    window: { enabled: false, start: '01:00', end: '08:00' },
    estimatedSpeedFactor: 7.7,
    freeSpaceMarginPercent: 5,
    maxAttempts: 3,
  },
  media: {
    extensions: ['.mkv', '.mp4', '.m4v', '.avi', '.ts', '.m2ts', '.mov', '.iso'],
    ignorePatterns: ['**/Sample/**', '**/*.sample.*', '**/.wololo-recycle/**', '**/@eaDir/**'],
    checkOnImport: true,
  },
  recycleBin: { enabled: true, retentionDays: 7, path: null },
  bdmv: {
    enabled: true,
    ambiguityPercent: 5,
    onAmbiguous: 'ask',
    minMatchScore: 0.8,
    extras: { enabled: false, minMinutes: 2 },
    deleteSourceWhenSeeded: false,
    rootFolderPath: null,
    qualityProfileId: null,
  },
  notifications: { rescanArr: true },
};
