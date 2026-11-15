import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import type { PlexService } from '../../contracts/integrations.ts';
import { type FakeUpstream, startFakeUpstream } from './fake-upstream.ts';
import { createPlexService, plexAuthUrl } from './plex-service.ts';

const ACCOUNT_TOKEN = 'account-token';
const SERVER_TOKEN = 'server-token';

let t: TestContext;
let tv: FakeUpstream;
let server: FakeUpstream;
let plex: PlexService;
let pinState: { authToken: string | null; expiresAt: string };

beforeEach(() => {
  t = createTestContext();
  pinState = { authToken: null, expiresAt: '2999-01-01T00:00:00Z' };
  server = startFakeUpstream({
    'GET /': () => ({ MediaContainer: { friendlyName: 'Pi', machineIdentifier: 'm1', version: '1.41.0' } }),
    'GET /library/sections': () => ({
      MediaContainer: {
        Directory: [
          { key: '1', title: 'Movies', type: 'movie', Location: [{ id: 1, path: '/plex/movies' }] },
          { key: 2, title: 'TV', type: 'show', Location: [{ id: 2, path: '/plex/tv' }] },
          { key: '3', title: 'Clips', type: 'clip', Location: [{ id: 3, path: '/plex/clips' }] },
        ],
      },
    }),
    'GET /library/sections/1/refresh': () => new Response(null, { status: 200 }),
    'GET /status/sessions': () => ({
      MediaContainer: {
        size: 1,
        Metadata: [
          {
            title: 'Heat',
            type: 'movie',
            User: { title: 'anna' },
            Player: { state: 'playing' },
            TranscodeSession: { videoDecision: 'copy', audioDecision: 'transcode' },
          },
        ],
      },
    }),
  });
  tv = startFakeUpstream({
    'POST /api/v2/pins': () => ({ id: 42, code: 'ABCD', authToken: null, expiresAt: '2999-01-01T00:00:00Z' }),
    'GET /api/v2/pins/42': () => ({ id: 42, code: 'ABCD', ...pinState }),
    'GET /api/v2/user': () => ({ username: 'stefan', title: 'Stefan' }),
    'GET /api/v2/resources': () => [
      { name: 'Player', provides: 'player', clientIdentifier: 'p1', owned: true, connections: [] },
      {
        name: 'Pi',
        provides: 'server',
        clientIdentifier: 'm1',
        owned: true,
        accessToken: SERVER_TOKEN,
        connections: [
          { protocol: 'https', uri: 'https://relay.plex.direct', local: false, relay: true },
          { protocol: 'http', uri: server.url, local: true, relay: false },
        ],
      },
    ],
  });
  plex = createPlexService(t.ctx, { plexTvUrl: tv.url, plexAppUrl: 'https://app.example' });
  t.ctx.services.plex = plex;
});

afterEach(() => {
  tv.stop();
  server.stop();
  t.cleanup();
});

async function signIn() {
  await plex.createPin();
  pinState.authToken = ACCOUNT_TOKEN;
  return plex.checkPin(42);
}

async function connectServer() {
  await signIn();
  return plex.update({ serverMachineId: 'm1', enabled: true });
}

test('plex.connection - starts signed out and keeps one client identifier', async () => {
  expect(await plex.connection()).toEqual({
    signedIn: false,
    username: null,
    serverName: null,
    serverMachineId: null,
    serverUrl: null,
    enabled: false,
    partialScan: true,
    pauseWhileStreaming: false,
  });
  await plex.createPin();
  await plex.createPin();
  const ids = tv.requestsTo('POST /api/v2/pins').map((request) => request.headers.get('x-plex-client-identifier'));
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBe(ids[0] ?? '');
});

test('plex.createPin - strong pin with product header and auth URL', async () => {
  const pin = await plex.createPin();
  const request = tv.requestsTo('POST /api/v2/pins')[0];
  expect(request?.query.get('strong')).toBe('true');
  expect(request?.headers.get('x-plex-product')).toBe('Wololo');
  expect(pin).toEqual({
    id: 42,
    code: 'ABCD',
    authUrl: plexAuthUrl('https://app.example', {
      clientIdentifier: request?.headers.get('x-plex-client-identifier') ?? '',
      code: 'ABCD',
    }),
    expiresAt: '2999-01-01T00:00:00Z',
  });
  expect(pin.authUrl).toStartWith('https://app.example/auth#?clientID=');
  expect(pin.authUrl).toContain('context%5Bdevice%5D%5Bproduct%5D=Wololo');
});

test('plex.checkPin - pending pin is neither authenticated nor expired', async () => {
  await plex.createPin();
  expect(await plex.checkPin(42)).toMatchObject({ authenticated: false, expired: false });
});

test('plex.checkPin - stores the account token and username once authorised', async () => {
  const status = await signIn();
  expect(status).toMatchObject({
    authenticated: true,
    expired: false,
    connection: { signedIn: true, username: 'stefan' },
  });
  expect(tv.requestsTo('GET /api/v2/user')[0]?.headers.get('x-plex-token')).toBe(ACCOUNT_TOKEN);
});

test('plex.checkPin - past expiry without token is expired', async () => {
  pinState.expiresAt = '2000-01-01T00:00:00Z';
  expect(await plex.checkPin(42)).toMatchObject({ authenticated: false, expired: true });
});

test('plex.checkPin - unknown pin (404 from plex.tv) is expired', async () => {
  expect(await plex.checkPin(7)).toMatchObject({ authenticated: false, expired: true });
});

test('plex.servers - requires sign-in', async () => {
  await expect(plex.servers()).rejects.toMatchObject({ code: 'precondition_failed' });
});

test('plex.servers - lists only servers with their connections', async () => {
  await signIn();
  expect(await plex.servers()).toEqual([
    {
      machineId: 'm1',
      name: 'Pi',
      owned: true,
      connections: [
        { uri: 'https://relay.plex.direct', local: false, relay: true },
        { uri: server.url, local: true, relay: false },
      ],
    },
  ]);
  const request = tv.requestsTo('GET /api/v2/resources')[0];
  expect(request?.headers.get('x-plex-token')).toBe(ACCOUNT_TOKEN);
  expect(request?.query.get('includeHttps')).toBe('1');
});

test('plex.update - selecting a server picks the local connection and its token', async () => {
  const connection = await connectServer();
  expect(connection).toMatchObject({
    serverMachineId: 'm1',
    serverName: 'Pi',
    serverUrl: server.url,
    enabled: true,
  });
  await plex.sections();
  expect(server.requestsTo('GET /library/sections')[0]?.headers.get('x-plex-token')).toBe(SERVER_TOKEN);
});

test('plex.update - unknown server is not found', async () => {
  await signIn();
  await expect(plex.update({ serverMachineId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
});

test('plex.update - enabling without a server is a precondition failure', async () => {
  await expect(plex.update({ enabled: true })).rejects.toMatchObject({ code: 'precondition_failed' });
});

test('plex.update - a manual URL never receives the account token', async () => {
  await signIn();
  await plex.update({ serverUrl: server.url, partialScan: false, pauseWhileStreaming: true });
  expect(await plex.connection()).toMatchObject({
    serverUrl: server.url,
    serverMachineId: null,
    partialScan: false,
    pauseWhileStreaming: true,
  });
  await plex.sections();
  expect(server.requests.at(-1)?.headers.get('x-plex-token')).toBeNull();
});

test('plex.update - switching the selected server to an unlisted URL drops its token', async () => {
  await connectServer();
  const evil = startFakeUpstream({ 'GET /': () => ({ MediaContainer: { friendlyName: 'Evil' } }) });
  try {
    expect(await plex.update({ serverUrl: evil.url })).toMatchObject({
      serverUrl: evil.url,
      serverMachineId: null,
      serverName: null,
    });
    await plex.test();
    expect(evil.requests).toHaveLength(1);
    expect(evil.requests[0]?.headers.get('x-plex-token')).toBeNull();
  } finally {
    evil.stop();
  }
});

test('plex.update - a URL whose address plex.tv lists for the selected server keeps its token', async () => {
  await connectServer();
  tv.on('GET /api/v2/resources', () => [
    {
      name: 'Pi',
      provides: 'server',
      clientIdentifier: 'm1',
      accessToken: SERVER_TOKEN,
      connections: [{ uri: 'https://pi.plex.direct:1', address: '127.0.0.1', port: Number(new URL(server.url).port) }],
    },
  ]);
  expect(await plex.update({ serverUrl: server.url })).toMatchObject({ serverUrl: server.url, serverMachineId: 'm1' });
  await plex.sections();
  expect(server.requests.at(-1)?.headers.get('x-plex-token')).toBe(SERVER_TOKEN);
});

test('plex.update - a server with an unlisted URL is refused', async () => {
  await signIn();
  const update = plex.update({ serverMachineId: 'm1', serverUrl: 'http://collector.example:32400' });
  await expect(update).rejects.toMatchObject({ code: 'unprocessable' });
  expect((await plex.connection()).serverUrl).toBeNull();
});

test('plex.sections - keeps known types and stringifies keys', async () => {
  await connectServer();
  expect(await plex.sections()).toEqual([
    { key: '1', title: 'Movies', type: 'movie', locations: ['/plex/movies'] },
    { key: '2', title: 'TV', type: 'show', locations: ['/plex/tv'] },
  ]);
});

test('plex.test - connected server reports name and version', async () => {
  expect(await plex.test()).toEqual({ ok: false, message: 'no Plex server selected', version: null });
  await connectServer();
  expect(await plex.test()).toEqual({ ok: true, message: 'Connected to Pi', version: '1.41.0' });
});

test('plex.test - rejected token is not ok', async () => {
  await connectServer();
  server.on('GET /', () => new Response('no', { status: 401 }));
  expect(await plex.test()).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 401') });
});

test('plex.refreshPath - partial scan of the mapped path in the matching section', async () => {
  await connectServer();
  await t.ctx.services.pathMappings.create({ scope: 'plex', remotePath: '/plex/movies', localPath: '/data/movies' });
  await plex.refreshPath('/data/movies/Heat (1995)');
  const refresh = server.requestsTo('GET /library/sections/1/refresh');
  expect(refresh).toHaveLength(1);
  expect(refresh[0]?.query.get('path')).toBe('/plex/movies/Heat (1995)');
  expect(refresh[0]?.headers.get('x-plex-token')).toBe(SERVER_TOKEN);
});

test('plex.refreshPath - no matching section skips the refresh', async () => {
  await connectServer();
  await plex.refreshPath('/elsewhere/Heat');
  expect(server.requests.filter((request) => request.path.endsWith('/refresh'))).toHaveLength(0);
  expect(server.requestsTo('GET /library/sections')).toHaveLength(1);
});

test('plex.refreshPath - no-op while disabled or without partial scan', async () => {
  await plex.refreshPath('/plex/movies/Heat');
  await connectServer();
  await plex.update({ partialScan: false });
  await plex.refreshPath('/plex/movies/Heat');
  expect(server.requests.filter((request) => request.path.startsWith('/library'))).toHaveLength(0);
  const skipped = t.ctx.logs
    .entries({ module: 'plex' })
    .filter((entry) => entry.level === 'info' && entry.message.startsWith('Plex partial scan skipped'));
  expect(skipped).toHaveLength(1);
});

test('plex.refreshPath - server errors throw upstream', async () => {
  await connectServer();
  server.on('GET /library/sections/1/refresh', () => new Response('x', { status: 500 }));
  await expect(plex.refreshPath('/plex/movies/Heat')).rejects.toMatchObject({ code: 'upstream' });
});

test('plex.sessions - maps active sessions', async () => {
  expect(await plex.sessions()).toEqual({ active: 0, sessions: [] });
  await connectServer();
  expect(await plex.sessions()).toEqual({
    active: 1,
    sessions: [{ title: 'Heat', user: 'anna', state: 'playing', transcoding: true }],
  });
});

test('plex.sessions - unreachable server counts as zero', async () => {
  await connectServer();
  server.stop();
  expect(await plex.sessions()).toEqual({ active: 0, sessions: [] });
});

test('plex.signOut - clears tokens and server, keeps settings defaults', async () => {
  await connectServer();
  expect(await plex.signOut()).toMatchObject({ signedIn: false, username: null, serverUrl: null, enabled: false });
  await expect(plex.servers()).rejects.toMatchObject({ code: 'precondition_failed' });
});

test('plex routes - pin flow and sessions through the API', async () => {
  const pin = await t.request('/api/v1/plex/pin', { method: 'POST' });
  expect(pin.status).toBe(200);
  pinState.authToken = ACCOUNT_TOKEN;
  const status = await t.request('/api/v1/plex/pin/42');
  expect(await status.json()).toMatchObject({ authenticated: true });
  const update = await t.request('/api/v1/plex', {
    method: 'PUT',
    body: JSON.stringify({ serverMachineId: 'm1', enabled: true }),
  });
  expect(update.status).toBe(200);
  expect(await (await t.request('/api/v1/plex/sessions')).json()).toMatchObject({ active: 1 });
  expect((await t.request('/api/v1/plex', { method: 'PUT', body: '{"serverUrl":"ftp://x"}' })).status).toBe(400);
  expect(await (await t.request('/api/v1/plex', { method: 'DELETE' })).json()).toMatchObject({ signedIn: false });
});
