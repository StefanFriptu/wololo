import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeUpstream, startFakeUpstream } from '../../src/modules/integrations/fake-upstream.ts';
import type { MediaFileSummary, Paginated, WebhookResponse } from '../../src/shared/api-types.ts';
import type { ArrInstance, JobSummary } from '../../src/shared/domain.ts';
import { createTemplateProfile } from '../helpers/createTemplateProfile.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../helpers/fixtures.ts';
import {
  type ApiCall,
  apiClient,
  eventually,
  ffprobeJson,
  type InProcessServer,
  startInProcessServer,
} from '../helpers/server.ts';

interface Probe {
  streams: { codec_type: string; codec_name: string }[];
}

let dir: string;
let server: InProcessServer;
let call: ApiCall;
let radarr: FakeUpstream;
let sonarr: FakeUpstream;
let plex: FakeUpstream;
let radarrId: number;
let movies: string;
let tv: string;

const RADARR_MOVIES = [
  { id: 11, title: 'Hook Movie', path: '/movies/Hook Movie (2022)', originalLanguage: { name: 'English' } },
  { id: 12, title: 'Upgrade Movie', path: '/movies/Upgrade Movie (2023)', originalLanguage: { name: 'English' } },
];

function webhook(kind: 'radarr' | 'sonarr', body: unknown, query: string, headers: Record<string, string> = {}) {
  return fetch(`${server.base}/api/v1/webhook/${kind}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function radarrDownload(movie: (typeof RADARR_MOVIES)[number], isUpgrade: boolean) {
  const file = `${movie.path.split('/').pop()}.mkv`;
  return {
    eventType: 'Download',
    isUpgrade,
    movie: { id: movie.id, title: movie.title, folderPath: movie.path, originalLanguage: { id: 1, name: 'English' } },
    movieFile: { id: movie.id * 10, relativePath: file, path: `${movie.path}/${file}` },
  };
}

async function finishedJob(mediaFileId: number): Promise<JobSummary> {
  const page = await eventually(
    `job of media ${mediaFileId}`,
    () => call<Paginated<JobSummary>>(`/api/v1/jobs?mediaFileId=${mediaFileId}&state=completed,failed`),
    (jobs) => jobs.total > 0,
  );
  return page.items[0] as JobSummary;
}

async function audioCodecs(path: string): Promise<string[]> {
  const probe = await ffprobeJson<Probe>(path);
  return probe.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.codec_name);
}

function commandsTo(upstream: FakeUpstream): unknown[] {
  return upstream.requestsTo('POST /api/v3/command').map((request) => JSON.parse(request.body));
}

function plexRefreshes(): { section: string; path: string | null; token: string | null }[] {
  return plex.requests
    .filter((request) => request.path.endsWith('/refresh'))
    .map((request) => ({
      section: request.path.split('/')[3] as string,
      path: request.query.get('path'),
      token: request.headers.get('x-plex-token'),
    }));
}

describe.skipIf(!ffmpegAvailable())(
  'real server: webhooks -> job -> Radarr/Sonarr rescan and Plex partial scan',
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'wololo-webhooks-'));
      movies = join(dir, 'media', 'movies');
      tv = join(dir, 'media', 'tv');
      radarr = startFakeUpstream({
        'GET /api/v3/system/status': () => ({ appName: 'Radarr', version: '5.14.0' }),
        'GET /api/v3/movie': () => RADARR_MOVIES,
        'POST /api/v3/command': () => ({ id: 1 }),
      });
      sonarr = startFakeUpstream({
        'GET /api/v3/system/status': () => ({ appName: 'Sonarr', version: '4.0.0' }),
        'GET /api/v3/series': () => [{ id: 21, title: 'Show', path: '/tv/Show', originalLanguage: { name: 'German' } }],
        'GET /api/v3/episodefile': () => [{ id: 211, path: '/tv/Show/Season 01/Show - S01E01.mkv' }],
        'POST /api/v3/command': () => ({ id: 2 }),
      });
      plex = startFakeUpstream({
        'GET /': () => ({ MediaContainer: { friendlyName: 'Pi', machineIdentifier: 'm1', version: '1.41.0' } }),
        'GET /library/sections': () => ({
          MediaContainer: {
            Directory: [
              { key: '1', title: 'Movies', type: 'movie', Location: [{ path: '/data/movies' }] },
              { key: '2', title: 'TV', type: 'show', Location: [{ path: '/data/tv' }] },
            ],
          },
        }),
        'GET /library/sections/1/refresh': () => new Response(null, { status: 200 }),
        'GET /library/sections/2/refresh': () => new Response(null, { status: 200 }),
        'GET /status/sessions': () => ({ MediaContainer: { size: 0 } }),
      });
      await ensureFixtureCopy(FIXTURES.dts51, join(movies, 'Hook Movie (2022)'), 'Hook Movie (2022).mkv');
      await ensureFixtureCopy(FIXTURES.dts51, join(movies, 'Upgrade Movie (2023)'), 'Upgrade Movie (2023).mkv');
      await ensureFixtureCopy(FIXTURES.eac3Stereo, join(tv, 'Show', 'Season 01'), 'Show - S01E01.mkv');

      server = await startInProcessServer(dir);
      call = apiClient(
        () => server.base,
        () => server.apiKey,
      );
      await call('/api/v1/settings', {
        method: 'PUT',
        json: { processing: { enabled: true }, media: { importAction: 'convert_strictest' } },
      });
      const player = await createTemplateProfile(call, 'basic', 'Living room TV');
      await call('/api/v1/libraries', {
        method: 'POST',
        json: { name: 'Movies', kind: 'movies', roots: [movies], profileIds: [player.id] },
      });
      await call('/api/v1/libraries', {
        method: 'POST',
        json: { name: 'TV', kind: 'series', roots: [tv], profileIds: [player.id] },
      });
      radarrId = (
        await call<ArrInstance>('/api/v1/arr', {
          method: 'POST',
          json: { kind: 'radarr', name: 'Radarr', url: radarr.url, apiKey: 'radarr-key' },
        })
      ).id;
      await call('/api/v1/arr', {
        method: 'POST',
        json: { kind: 'sonarr', name: 'Sonarr', url: sonarr.url, apiKey: 'sonarr-key' },
      });
      for (const mapping of [
        { scope: 'radarr', remotePath: '/movies', localPath: movies },
        { scope: 'sonarr', remotePath: '/tv', localPath: tv },
        { scope: 'plex', remotePath: '/data/movies', localPath: movies },
        { scope: 'plex', remotePath: '/data/tv', localPath: tv },
      ])
        await call('/api/v1/pathmappings', { method: 'POST', json: mapping });
      await call('/api/v1/plex', {
        method: 'PUT',
        json: { serverUrl: plex.url, serverToken: 'plex-token', enabled: true, partialScan: true },
      });
    });

    afterAll(async () => {
      await server?.runtime.stop('test');
      for (const upstream of [radarr, sonarr, plex]) upstream?.stop();
      rmSync(dir, { recursive: true, force: true });
    });

    test('step 1 - the webhook needs the API key, in the header or as ?apikey=', async () => {
      const test = { eventType: 'Test', instanceName: 'Radarr' };
      expect((await webhook('radarr', test, '')).status).toBe(401);
      expect((await webhook('radarr', test, '', { 'x-api-key': 'wrong' })).status).toBe(401);
      const wrongQuery = await webhook('radarr', test, '?apikey=wrong');
      expect(wrongQuery.status).toBe(401);
      expect(await wrongQuery.text()).not.toContain(server.apiKey);

      const byQuery = await webhook('radarr', test, `?apikey=${server.apiKey}`);
      expect(await byQuery.json()).toMatchObject({ accepted: true, action: 'test' });
      const byHeader = await webhook('sonarr', { eventType: 'Test' }, '', { 'x-api-key': server.apiKey });
      expect(await byHeader.json()).toMatchObject({ accepted: true, action: 'test' });
    });

    test('step 2 - events other than an import are acknowledged and ignored', async () => {
      for (const eventType of ['Grab', 'SomethingNew']) {
        const response = await webhook('radarr', { eventType }, `?apikey=${server.apiKey}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ accepted: true, action: 'ignored', mediaFileIds: [] });
      }
      expect((await call<Paginated<JobSummary>>('/api/v1/jobs')).total).toBe(0);
    });

    test('step 3 - a Radarr import is converted, Radarr rescans the movie and Plex scans the mapped folder', async () => {
      const movie = RADARR_MOVIES[0] as (typeof RADARR_MOVIES)[number];
      const response = await webhook(
        'radarr',
        radarrDownload(movie, false),
        `?apikey=${server.apiKey}&instance=${radarrId}`,
      );
      const result = (await response.json()) as WebhookResponse;
      expect(result).toMatchObject({ accepted: true, action: 'queued' });

      const job = await finishedJob(result.mediaFileIds[0] as number);
      expect(job).toMatchObject({ state: 'completed', trigger: 'webhook' });
      expect(await audioCodecs(join(movies, 'Hook Movie (2022)', 'Hook Movie (2022).mkv'))).toEqual(['ac3']);
      await eventually(
        'Radarr rescan',
        async () => commandsTo(radarr),
        (commands) => commands.length > 0,
      );
      expect(commandsTo(radarr)).toEqual([{ name: 'RescanMovie', movieId: 11 }]);
      expect(radarr.requestsTo('POST /api/v3/command')[0]?.headers.get('x-api-key')).toBe('radarr-key');
      await eventually(
        'Plex partial scan',
        async () => plexRefreshes(),
        (refreshes) => refreshes.length > 0,
      );
      expect(plexRefreshes()).toEqual([{ section: '1', path: '/data/movies/Hook Movie (2022)', token: 'plex-token' }]);
    });

    test('step 4 - an upgrade import with the key in the header resolves the only Radarr instance', async () => {
      const movie = RADARR_MOVIES[1] as (typeof RADARR_MOVIES)[number];
      const response = await webhook('radarr', radarrDownload(movie, true), '', { 'x-api-key': server.apiKey });
      const result = (await response.json()) as WebhookResponse;
      expect(result.action).toBe('queued');
      expect((await finishedJob(result.mediaFileIds[0] as number)).state).toBe('completed');
      await eventually(
        'second Radarr rescan',
        async () => commandsTo(radarr),
        (commands) => commands.length === 2,
      );
      expect(commandsTo(radarr)[1]).toEqual({ name: 'RescanMovie', movieId: 12 });
    });

    test('step 5 - a Sonarr upgrade is converted, Sonarr rescans the series and Plex scans the season folder', async () => {
      const response = await webhook(
        'sonarr',
        {
          eventType: 'Download',
          isUpgrade: true,
          series: { id: 21, title: 'Show', path: '/tv/Show', originalLanguage: { id: 4, name: 'German' } },
          episodes: [{ id: 1, episodeNumber: 1, seasonNumber: 1 }],
          episodeFile: {
            id: 211,
            relativePath: 'Season 01/Show - S01E01.mkv',
            path: '/tv/Show/Season 01/Show - S01E01.mkv',
          },
        },
        `?apikey=${server.apiKey}`,
      );
      const result = (await response.json()) as WebhookResponse;
      expect(result.action).toBe('queued');
      expect((await finishedJob(result.mediaFileIds[0] as number)).state).toBe('completed');
      expect(await audioCodecs(join(tv, 'Show', 'Season 01', 'Show - S01E01.mkv'))).toEqual(['ac3']);
      await eventually(
        'Sonarr rescan',
        async () => commandsTo(sonarr),
        (commands) => commands.length > 0,
      );
      expect(commandsTo(sonarr)).toEqual([{ name: 'RescanSeries', seriesId: 21 }]);
      await eventually(
        'TV partial scan',
        async () => plexRefreshes(),
        (refreshes) => refreshes.length === 3,
      );
      expect(plexRefreshes()[2]).toEqual({ section: '2', path: '/data/tv/Show/Season 01', token: 'plex-token' });
    });

    test('step 6 - an import outside every library root is reported, nothing is queued', async () => {
      const before = (await call<Paginated<JobSummary>>('/api/v1/jobs')).total;
      const response = await webhook(
        'radarr',
        {
          ...radarrDownload(
            { id: 99, title: 'Elsewhere', path: '/elsewhere/Elsewhere (2020)', originalLanguage: { name: 'English' } },
            false,
          ),
        },
        `?apikey=${server.apiKey}`,
      );
      expect(await response.json()).toMatchObject({ action: 'unknown_path', mediaFileIds: [] });
      expect((await call<Paginated<JobSummary>>('/api/v1/jobs')).total).toBe(before);
      const rows = await call<Paginated<MediaFileSummary>>('/api/v1/media?search=Elsewhere');
      expect(rows.total).toBe(0);
    });
  },
);
