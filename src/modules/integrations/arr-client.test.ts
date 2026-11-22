import { afterEach, expect, test } from 'bun:test';
import { createArrClient } from './arr-client.ts';
import { type FakeUpstream, startFakeUpstream } from './fake-upstream.ts';

let upstream: FakeUpstream | null = null;

afterEach(() => upstream?.stop());

test('arr client - a library call can outlast the default timeout', async () => {
  const slowly = async <T>(body: T) => {
    await Bun.sleep(150);
    return body;
  };
  upstream = startFakeUpstream({
    'GET /api/v3/movie': () => slowly([{ id: 1, title: 'Heat', path: '/vault/movies/Heat (1995)' }]),
    'GET /api/v3/series': () => slowly([{ id: 2, title: 'Show', path: '/vault/tv/Show' }]),
    'GET /api/v3/system/status': () => slowly({ appName: 'Radarr', version: '5' }),
  });
  const client = createArrClient({ kind: 'radarr', url: upstream.url, apiKey: 'k', timeoutMs: 50 });
  expect((await client.movies(2_000)).map((movie) => movie.id)).toEqual([1]);
  expect((await client.series(2_000)).map((series) => series.id)).toEqual([2]);
  await expect(client.systemStatus()).rejects.toMatchObject({
    code: 'upstream',
    message: expect.stringContaining('timed out'),
  });
  await expect(client.movies()).rejects.toMatchObject({ code: 'upstream' });
});

test.each([
  ['radarr', 'GET /api/v3/history/movie', 'movieId'],
  ['sonarr', 'GET /api/v3/history/series', 'seriesId'],
] as const)(
  'arr client itemImports - %s asks its per-item history and keeps imports with a hash',
  async (kind, key, param) => {
    upstream = startFakeUpstream({
      [key]: () => [
        { eventType: 'downloadFolderImported', downloadId: 'ABC', data: { importedPath: '/movies/A/a.mkv' } },
        { eventType: 'downloadFolderImported', downloadId: null, data: { importedPath: '/movies/A/manual.mkv' } },
        { eventType: 'downloadFolderImported', downloadId: 'DEF', data: {} },
        { eventType: 'grabbed', downloadId: 'GHI', data: { importedPath: '/movies/A/g.mkv' } },
      ],
    });
    const client = createArrClient({ kind, url: upstream.url, apiKey: 'k' });

    expect(await client.itemImports(7)).toEqual([{ downloadId: 'ABC', importedPath: '/movies/A/a.mkv' }]);
    const [request] = upstream.requestsTo(key);
    expect(request?.query.get(param)).toBe('7');
    expect(request?.query.get('eventType')).toBe('3');
  },
);
