import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { eventually } from '../../../test/helpers/server.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { ArrService, FileChangedEvent, PlexService } from '../../contracts/integrations.ts';
import { AppError } from '../../core/errors.ts';
import type { ArrItemRef } from '../../shared/domain.ts';
import type { DeepPartial, Settings } from '../../shared/settings.ts';
import { createNotifierService } from './notifier-service.ts';

const REF: ArrItemRef = { instanceId: 1, kind: 'radarr', itemId: 7, fileId: 3 };

let t: TestContext;
let rescans: ArrItemRef[];
let lookups: string[];
let refreshes: string[];
let rescanAttempts: number;

function setup(
  options: {
    found?: ArrItemRef | null;
    rescanError?: Error;
    rescanFailures?: Error[];
    refreshError?: Error;
    settings?: DeepPartial<Settings>;
  } = {},
) {
  rescans = [];
  rescanAttempts = 0;
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
          rescanAttempts += 1;
          if (options.rescanError) throw options.rescanError;
          const failure = options.rescanFailures?.shift();
          if (failure) throw failure;
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

test('notifier.fileChanged - rescanArr off skips the arr rescan, Plex still decides on its own flag', async () => {
  setup({ settings: { notifications: { rescanArr: false } } });
  await t.ctx.services.notifier.fileChanged(event());
  expect(rescans).toEqual([]);
  expect(refreshes).toHaveLength(1);
});

test('notifier.fileChanged - errors are logged, never thrown, and do not stop Plex', async () => {
  setup({ rescanError: new Error('radarr down'), refreshError: new Error('plex down') });
  await t.ctx.services.notifier.fileChanged(event());
  const errors = t.ctx.logs.entries({ level: 'error', module: 'notifier' }).map((entry) => entry.message);
  expect(errors.toSorted()).toEqual(['Plex partial scan failed', 'arr rescan failed']);
});

function upstreamError(status: number | null): AppError {
  return new AppError('upstream', `Radarr POST /api/v3/command: HTTP ${status}`, { status });
}

function notifierErrors(): string[] {
  return t.ctx.logs.entries({ level: 'error', module: 'notifier' }).map((entry) => entry.message);
}

test('notifier - retries a 503 rescan in the background without blocking fileChanged', async () => {
  setup({ rescanFailures: [upstreamError(503)] });
  const gate = Promise.withResolvers<void>();
  const waits: number[] = [];
  const notifier = createNotifierService(t.ctx, {
    retryDelaysMs: [5_000, 30_000],
    sleep: async (ms) => {
      waits.push(ms);
      await gate.promise;
    },
  });
  await notifier.fileChanged(event());
  expect(rescanAttempts).toBe(1);
  expect(rescans).toEqual([]);
  expect(refreshes).toHaveLength(1);
  gate.resolve();
  await eventually(
    'rescan retried',
    async () => rescans,
    (done) => done.length === 1,
    2_000,
  );
  expect(rescanAttempts).toBe(2);
  expect(waits).toEqual([5_000]);
  expect(notifierErrors()).toEqual([]);
});

test('notifier - a network failure keeps retrying until the delays run out, then logs an error', async () => {
  setup({ rescanFailures: [upstreamError(null), upstreamError(null), upstreamError(429)] });
  const notifier = createNotifierService(t.ctx, { retryDelaysMs: [1, 1], sleep: async () => undefined });
  await notifier.fileChanged(event());
  await eventually(
    'retries exhausted',
    async () => notifierErrors(),
    (errors) => errors.length > 0,
    2_000,
  );
  expect(rescanAttempts).toBe(3);
  expect(notifierErrors()).toEqual(['arr rescan failed']);
});

test('notifier - rejected credentials are not retried', async () => {
  setup({ rescanFailures: [upstreamError(401)] });
  const waits: number[] = [];
  const notifier = createNotifierService(t.ctx, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await notifier.fileChanged(event());
  expect(rescanAttempts).toBe(1);
  expect(waits).toEqual([]);
  expect(notifierErrors()).toEqual(['arr rescan failed']);
});

test('notifier - a pending retry is dropped on shutdown', async () => {
  setup({ rescanFailures: [upstreamError(502)] });
  const notifier = createNotifierService(t.ctx, { retryDelaysMs: [60_000] });
  await notifier.fileChanged(event());
  expect(rescanAttempts).toBe(1);
  t.ctx.requestShutdown();
  await Bun.sleep(10);
  expect(rescanAttempts).toBe(1);
  expect(notifierErrors()).toEqual([]);
});
