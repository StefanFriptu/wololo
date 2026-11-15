import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { ArrService, FileChangedEvent, PlexService } from '../../contracts/integrations.ts';
import type { ArrItemRef } from '../../shared/domain.ts';
import type { DeepPartial, Settings } from '../../shared/settings.ts';

const REF: ArrItemRef = { instanceId: 1, kind: 'radarr', itemId: 7, fileId: 3 };

let t: TestContext;
let rescans: ArrItemRef[];
let lookups: string[];
let refreshes: string[];

function setup(
  options: {
    found?: ArrItemRef | null;
    rescanError?: Error;
    refreshError?: Error;
    settings?: DeepPartial<Settings>;
  } = {},
) {
  rescans = [];
  lookups = [];
  refreshes = [];
  t = createTestContext({
    settings: options.settings,
    overrides: {
      arr: stubService<ArrService>('arr', {
        findByPath: async (path) => {
          lookups.push(path);
          return options.found ? { ref: options.found, originalLanguage: null } : null;
        },
        rescan: async (ref) => {
          if (options.rescanError) throw options.rescanError;
          rescans.push(ref);
        },
      }),
      plex: stubService<PlexService>('plex', {
        refreshPath: async (path) => {
          if (options.refreshError) throw options.refreshError;
          refreshes.push(path);
        },
      }),
    },
  });
}

afterEach(() => t.cleanup());

function event(overrides: Partial<FileChangedEvent> = {}): FileChangedEvent {
  return {
    kind: 'replaced',
    localPath: '/data/movies/Heat (1995)/Heat.mkv',
    mediaFileId: 1,
    arr: REF,
    jobId: 9,
    ...overrides,
  };
}

test('notifier.fileChanged - replaced: rescans the known item, then refreshes the folder in Plex', async () => {
  setup();
  await t.ctx.services.notifier.fileChanged(event());
  expect(rescans).toEqual([REF]);
  expect(lookups).toEqual([]);
  expect(refreshes).toEqual(['/data/movies/Heat (1995)']);
});

test('notifier.fileChanged - replaced without ref: resolves it by path', async () => {
  const found = { ...REF, itemId: 70 };
  setup({ found });
  await t.ctx.services.notifier.fileChanged(event({ arr: null }));
  expect(lookups).toEqual(['/data/movies/Heat (1995)/Heat.mkv']);
  expect(rescans).toEqual([found]);
});

test('notifier.fileChanged - unresolved item skips the rescan but still refreshes Plex', async () => {
  setup({ found: null });
  await t.ctx.services.notifier.fileChanged(event({ arr: null }));
  expect(lookups).toHaveLength(1);
  expect(rescans).toEqual([]);
  expect(refreshes).toHaveLength(1);
});

test('notifier.fileChanged - created: Plex only', async () => {
  setup();
  await t.ctx.services.notifier.fileChanged(event({ kind: 'created' }));
  expect(rescans).toEqual([]);
  expect(refreshes).toEqual(['/data/movies/Heat (1995)']);
});

test('notifier.fileChanged - an existing directory is refreshed itself', async () => {
  setup();
  const folder = join(t.dir, 'Movie (2026)');
  mkdirSync(folder);
  await t.ctx.services.notifier.fileChanged(event({ kind: 'created', localPath: folder }));
  expect(refreshes).toEqual([folder]);
});

test('notifier.fileChanged - honours notification settings', async () => {
  setup({ settings: { notifications: { rescanArr: false, plexPartialScan: false } } });
  await t.ctx.services.notifier.fileChanged(event());
  expect(rescans).toEqual([]);
  expect(refreshes).toEqual([]);
  const skipped = t.ctx.logs
    .entries({ module: 'notifier' })
    .filter((entry) => entry.level === 'info')
    .map((entry) => entry.message);
  expect(skipped).toEqual(['Plex partial scan skipped: turned off in Settings > notifications']);
});

test('notifier.fileChanged - errors are logged, never thrown, and do not stop Plex', async () => {
  setup({ rescanError: new Error('radarr down'), refreshError: new Error('plex down') });
  await t.ctx.services.notifier.fileChanged(event());
  const errors = t.ctx.logs.entries({ level: 'error', module: 'notifier' }).map((entry) => entry.message);
  expect(errors.toSorted()).toEqual(['Plex partial scan failed', 'arr rescan failed']);
});
