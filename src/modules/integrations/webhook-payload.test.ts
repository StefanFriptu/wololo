import { expect, test } from 'bun:test';
import type { ArrInstance } from '../../shared/domain.ts';
import {
  combineWebhookActions,
  radarrImport,
  radarrWebhookSchema,
  resolveWebhookInstance,
  sonarrImport,
  sonarrWebhookSchema,
  webhookActionFor,
} from './webhook-payload.ts';

const radarr = (payload: unknown) => radarrImport(radarrWebhookSchema.parse(payload));
const sonarr = (payload: unknown) => sonarrImport(sonarrWebhookSchema.parse(payload));

const MOVIE = { id: 7, title: 'Heat', year: 1995, folderPath: '/movies/Heat (1995)' };

test('radarrImport - uses movieFile.path when present', () => {
  const result = radarr({
    eventType: 'Download',
    movie: { ...MOVIE, originalLanguage: { id: 1, name: 'English' } },
    movieFile: { id: 3, path: '/movies/Heat (1995)/Heat.mkv', relativePath: 'ignored.mkv' },
  });
  expect(result).toEqual({
    itemId: 7,
    originalLanguage: 'English',
    files: [{ remotePath: '/movies/Heat (1995)/Heat.mkv', fileId: 3 }],
  });
});

test('radarrImport - joins folderPath and relativePath without movieFile.path', () => {
  const result = radarr({ eventType: 'Download', movie: MOVIE, movieFile: { id: 3, relativePath: 'Heat.mkv' } });
  expect(result?.files).toEqual([{ remotePath: '/movies/Heat (1995)/Heat.mkv', fileId: 3 }]);
});

test('radarrImport - falls back to movie.filePath', () => {
  const result = radarr({ eventType: 'Download', movie: { ...MOVIE, filePath: '/movies/Heat (1995)/h.mkv' } });
  expect(result?.files).toEqual([{ remotePath: '/movies/Heat (1995)/h.mkv', fileId: null }]);
});

test('radarrImport - no movie yields null', () => {
  expect(radarr({ eventType: 'Download' })).toBeNull();
});

test('radarrImport - nulls count as absent', () => {
  const result = radarr({
    eventType: 'Download',
    movie: { ...MOVIE, imdbId: null, originalLanguage: null },
    movieFile: { id: 3, path: null, relativePath: 'Heat.mkv' },
  });
  expect(result).toEqual({
    itemId: 7,
    originalLanguage: null,
    files: [{ remotePath: '/movies/Heat (1995)/Heat.mkv', fileId: 3 }],
  });
});

test('radarrWebhookSchema - keeps unknown fields', () => {
  const parsed = radarrWebhookSchema.parse({ eventType: 'Grab', release: { quality: 'x' } });
  expect(parsed.release).toEqual({ quality: 'x' });
});

test('radarrWebhookSchema - rejects a payload without eventType', () => {
  expect(radarrWebhookSchema.safeParse({ movie: MOVIE }).success).toBe(false);
});

test('sonarrImport - collects episodeFile and episodeFiles without duplicates', () => {
  const result = sonarr({
    eventType: 'Download',
    series: { id: 4, title: 'Show', path: '/tv/Show', originalLanguage: { id: 4, name: 'German' } },
    episodeFile: { id: 10, relativePath: 'Season 01/e1.mkv' },
    episodeFiles: [
      { id: 10, relativePath: 'Season 01/e1.mkv' },
      { id: 11, path: '/tv/Show/Season 01/e2.mkv' },
    ],
  });
  expect(result).toEqual({
    itemId: 4,
    originalLanguage: 'German',
    files: [
      { remotePath: '/tv/Show/Season 01/e1.mkv', fileId: 10 },
      { remotePath: '/tv/Show/Season 01/e2.mkv', fileId: 11 },
    ],
  });
});

test('sonarrImport - file without any path is skipped', () => {
  const result = sonarr({ eventType: 'Download', series: { id: 4, title: 'Show' }, episodeFile: { id: 1 } });
  expect(result?.files).toEqual([]);
});

function instance(overrides: Partial<ArrInstance>): ArrInstance {
  return {
    id: 1,
    kind: 'radarr',
    name: 'Radarr',
    url: 'http://radarr:7878',
    apiKey: 'k',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const INSTANCES = [
  instance({ id: 1, name: 'Radarr', url: 'http://radarr:7878' }),
  instance({ id: 2, name: 'Radarr 4K', url: 'http://radarr4k:7878/' }),
  instance({ id: 3, kind: 'sonarr', name: 'Sonarr', url: 'http://sonarr:8989' }),
  instance({ id: 4, name: 'Old', url: 'http://old:7878', enabled: false }),
];

test.each([
  ['resolveWebhookInstance - explicit id', { kind: 'radarr', instanceId: 2 }, 2],
  ['resolveWebhookInstance - explicit id of a disabled instance', { kind: 'radarr', instanceId: 4 }, 4],
  ['resolveWebhookInstance - only enabled instance of the kind', { kind: 'sonarr', instanceId: null }, 3],
  [
    'resolveWebhookInstance - instanceName among several',
    { kind: 'radarr', instanceId: null, instanceName: 'Radarr 4K' },
    2,
  ],
  [
    'resolveWebhookInstance - applicationUrl ignores case and trailing slash',
    { kind: 'radarr', instanceId: null, applicationUrl: 'HTTP://radarr4k:7878' },
    2,
  ],
  [
    'resolveWebhookInstance - name wins over url',
    { kind: 'radarr', instanceId: null, instanceName: 'Radarr', applicationUrl: 'http://radarr4k:7878' },
    1,
  ],
] as const)('%s', (_name, request, expectedId) => {
  const result = resolveWebhookInstance(INSTANCES, request);
  expect(result.ok && result.instance.id).toBe(expectedId);
});

test.each([
  ['resolveWebhookInstance - unknown id', { kind: 'radarr', instanceId: 99 }, 'unknown radarr instance 99'],
  [
    'resolveWebhookInstance - id of the other kind',
    { kind: 'radarr', instanceId: 3 },
    'instance 3 is a sonarr instance',
  ],
  ['resolveWebhookInstance - ambiguous without hints', { kind: 'radarr', instanceId: null }, 'cannot tell'],
  ['resolveWebhookInstance - none configured', { kind: 'sonarr', instanceId: null }, 'no sonarr instance configured'],
] as const)('%s', (_name, request, reason) => {
  const instances = request.kind === 'sonarr' && reason.startsWith('no') ? INSTANCES.slice(0, 2) : INSTANCES;
  const result = resolveWebhookInstance(instances, request);
  expect(result.ok).toBe(false);
  expect(result.ok ? '' : result.reason).toContain(reason);
});

test.each([
  ['compatible', 'compatible'],
  ['queued', 'queued'],
  ['dry_run', 'dry_run'],
  ['unknown_path', 'unknown_path'],
  ['ignored', 'ignored'],
  ['blocked', 'blocked'],
  ['decision_required', 'decision_required'],
  ['failed', 'error'],
] as const)('webhookActionFor - %s maps to %s', (check, expected) => {
  expect(webhookActionFor(check)).toBe(expected);
});

test.each([
  ['combineWebhookActions - error wins', ['compatible', 'error', 'queued'], 'error'],
  ['combineWebhookActions - queued beats dry_run', ['dry_run', 'queued'], 'queued'],
  ['combineWebhookActions - all compatible', ['compatible', 'compatible'], 'compatible'],
  ['combineWebhookActions - empty input', [], 'ignored'],
] as const)('%s', (_name, actions, expected) => {
  expect(combineWebhookActions(actions)).toBe(expected);
});
