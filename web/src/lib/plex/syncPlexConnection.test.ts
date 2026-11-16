import { afterEach, expect, test } from 'bun:test';
import type { PlexConnection } from '#lib/shared.ts';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { Resource } = await import('#lib/resource.svelte.ts');
const { effectScope } = await import('#lib/testing/effectScope.svelte.ts');
const { syncPlexConnection } = await import('./syncPlexConnection.svelte.ts');

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const connected = (overrides: Partial<PlexConnection> = {}): PlexConnection => ({
  signedIn: true,
  username: 'me',
  serverName: 'Plex',
  serverMachineId: 'abc',
  serverUrl: 'http://plex:32400',
  enabled: true,
  partialScan: true,
  pauseWhileStreaming: false,
  ...overrides,
});

function setup(initial: PlexConnection) {
  const connection = new Resource<PlexConnection>(async () => initial);
  connection.set(initial);
  const calls = { servers: 0, serverData: 0, resets: [] as string[][] };
  const scope = effectScope(() =>
    syncPlexConnection({
      connection: () => connection.data,
      onSavedServer: (machineId, url) => calls.resets.push([machineId, url]),
      loadServers: () => {
        calls.servers += 1;
      },
      loadServerData: () => {
        calls.serverData += 1;
      },
    }),
  );
  stops.push(scope.stop);
  return { connection, calls, flush: scope.flush };
}

test('syncPlexConnection - first load resets the form and loads servers and server data', () => {
  const { calls } = setup(connected());
  expect(calls).toEqual({ servers: 1, serverData: 1, resets: [['abc', 'http://plex:32400']] });
});

test('syncPlexConnection - toggling a switch neither resets the form nor reloads', () => {
  const { connection, calls, flush } = setup(connected());
  connection.set(connected({ pauseWhileStreaming: true }));
  flush();
  connection.set(connected({ pauseWhileStreaming: true, enabled: false }));
  flush();
  expect(calls).toEqual({ servers: 1, serverData: 1, resets: [['abc', 'http://plex:32400']] });
});

test('syncPlexConnection - saving another server resets the form and reloads its data', () => {
  const { connection, calls, flush } = setup(connected());
  connection.set(connected({ serverMachineId: 'def', serverUrl: 'http://other:32400' }));
  flush();
  expect(calls.resets.at(-1)).toEqual(['def', 'http://other:32400']);
  expect(calls.serverData).toBe(2);
  expect(calls.servers).toBe(1);
});

test('syncPlexConnection - signed out loads nothing', () => {
  const { calls } = setup(connected({ signedIn: false, serverMachineId: null, serverUrl: null }));
  expect(calls).toEqual({ servers: 0, serverData: 0, resets: [['', '']] });
});
