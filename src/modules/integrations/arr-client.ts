import { z } from 'zod';
import type { ArrKind } from '../../shared/domain.ts';
import { type FetchLike, upstreamJson } from './upstream.ts';

const SERVICE_NAME: Readonly<Record<ArrKind, string>> = { radarr: 'Radarr', sonarr: 'Sonarr' };

const languageSchema = z.object({ name: z.string() }).nullish();

const systemStatusSchema = z.object({ appName: z.string().nullish(), version: z.string() });
const rootFolderSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  accessible: z.boolean().nullish(),
  freeSpace: z.number().nullish(),
});
const qualityProfileSchema = z.object({ id: z.number().int(), name: z.string() });
const lookupMovieSchema = z.object({
  id: z.number().int().nullish(),
  title: z.string(),
  originalTitle: z.string().nullish(),
  year: z.number().int().nullish(),
  tmdbId: z.number().int(),
  imdbId: z.string().nullish(),
});
const movieSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  path: z.string().nullish(),
  tmdbId: z.number().int().nullish(),
  originalLanguage: languageSchema,
  movieFile: z.object({ id: z.number().int(), path: z.string().nullish() }).nullish(),
});
const seriesSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  path: z.string().nullish(),
  originalLanguage: languageSchema,
});
const episodeFileSchema = z.object({ id: z.number().int(), path: z.string().nullish() });
const historySchema = z.object({
  records: z.array(
    z.object({
      eventType: z.string(),
      downloadId: z.string().nullish(),
      data: z.record(z.string(), z.string().nullish()).nullish(),
    }),
  ),
});
const commandSchema = z.object({ id: z.number().int() }).loose();
const addedMovieSchema = z.object({ id: z.number().int() }).loose();

export type ArrLookupMovie = z.infer<typeof lookupMovieSchema>;
export type ArrMovie = z.infer<typeof movieSchema>;
export type ArrSeries = z.infer<typeof seriesSchema>;

/** History eventType 3 is downloadFolderImported in both Radarr and Sonarr. */
const DOWNLOAD_FOLDER_IMPORTED = '3';
const HISTORY_PAGE_SIZE = '250';

export interface ArrImportRecord {
  /** Path of the file in the download folder (Radarr/Sonarr's view). */
  droppedPath: string;
  /** Path of the imported library file (Radarr/Sonarr's view) at import time. */
  importedPath: string;
}

function dataValue(data: Record<string, string | null | undefined> | null | undefined, key: string): string | null {
  if (!data) return null;
  const wanted = key.toLowerCase();
  const entry = Object.entries(data).find(([name]) => name.toLowerCase() === wanted);
  return entry?.[1] || null;
}

export type ArrCommand =
  | { name: 'RescanMovie'; movieId: number }
  | { name: 'RescanSeries'; seriesId: number }
  | { name: 'DownloadedMoviesScan'; path: string };

export interface NewRadarrMovie {
  title: string;
  tmdbId: number;
  year: number | null;
  qualityProfileId: number;
  rootFolderPath: string;
}

export interface ArrClientOptions {
  kind: ArrKind;
  url: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type ArrClient = ReturnType<typeof createArrClient>;

/** Radarr/Sonarr API v3 (X-Api-Key). Every response is validated; failures throw AppError('upstream'). */
export function createArrClient(options: ArrClientOptions) {
  const base = options.url.trim().replace(/\/+$/, '');
  const service = SERVICE_NAME[options.kind];

  const call = <T extends z.ZodType>(
    path: string,
    schema: T,
    init: { method?: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ) => {
    const url = new URL(`${base}/api/v3/${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { 'X-Api-Key': options.apiKey };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return upstreamJson(
      {
        service,
        url,
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        fetch: options.fetch,
        timeoutMs: init.timeoutMs ?? options.timeoutMs,
      },
      schema,
    );
  };

  return {
    service,
    systemStatus: () => call('system/status', systemStatusSchema),
    rootFolders: () => call('rootfolder', z.array(rootFolderSchema)),
    qualityProfiles: () => call('qualityprofile', z.array(qualityProfileSchema)),
    lookupMovies: (term: string) => call('movie/lookup', z.array(lookupMovieSchema), { query: { term } }),
    lookupTmdb: (tmdbId: number) => call('movie/lookup/tmdb', lookupMovieSchema, { query: { tmdbId: String(tmdbId) } }),
    movies: (timeoutMs?: number) => call('movie', z.array(movieSchema), { timeoutMs }),
    movie: (id: number) => call(`movie/${id}`, movieSchema),
    series: (timeoutMs?: number) => call('series', z.array(seriesSchema), { timeoutMs }),
    episodeFiles: (seriesId: number) =>
      call('episodefile', z.array(episodeFileSchema), { query: { seriesId: String(seriesId) } }),
    /** GET /api/v3/history?downloadId= (import events only); downloadId is the client's hash, Radarr/Sonarr store it upper case. */
    imports: async (downloadId: string): Promise<ArrImportRecord[]> => {
      const history = await call('history', historySchema, {
        query: {
          downloadId: downloadId.toUpperCase(),
          eventType: DOWNLOAD_FOLDER_IMPORTED,
          pageSize: HISTORY_PAGE_SIZE,
        },
      });
      return history.records.flatMap((record) => {
        if (record.eventType !== 'downloadFolderImported') return [];
        const droppedPath = dataValue(record.data, 'droppedPath');
        const importedPath = dataValue(record.data, 'importedPath');
        return droppedPath && importedPath ? [{ droppedPath, importedPath }] : [];
      });
    },
    command: (command: ArrCommand) => call('command', commandSchema, { method: 'POST', body: command }),
    addMovie: async (movie: NewRadarrMovie) => {
      const added = await call('movie', addedMovieSchema, {
        method: 'POST',
        body: {
          title: movie.title,
          tmdbId: movie.tmdbId,
          year: movie.year ?? undefined,
          qualityProfileId: movie.qualityProfileId,
          rootFolderPath: movie.rootFolderPath,
          monitored: true,
          minimumAvailability: 'released',
          addOptions: { searchForMovie: false },
        },
      });
      return added.id;
    },
  };
}
