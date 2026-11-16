import { afterEach, describe, expect, test } from 'bun:test';
import { AppError } from '../../src/core/errors.ts';
import type { LogData, Logger } from '../../src/core/logger.ts';
import { deepMerge, SettingsStore } from '../../src/core/settings.ts';
import { settings as settingsTable } from '../../src/db/schema.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let t: TestContext | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('SettingsStore', () => {
  test('returns defaults, persists partial updates and emits settings.changed', () => {
    t = createTestContext();
    expect(t.ctx.settings.get()).toEqual(DEFAULT_SETTINGS);
    const changed: string[][] = [];
    t.ctx.events.on('settings.changed', ({ sections }) => changed.push(sections));
    t.ctx.settings.update({
      processing: { window: { enabled: true } },
      recycleBin: { retentionDays: 3 },
    });
    expect(t.ctx.settings.section('processing').window).toEqual({
      enabled: true,
      start: '01:00',
      end: '08:00',
    });
    expect(changed).toEqual([['processing', 'recycleBin']]);
    const reloaded = new SettingsStore(t.ctx.db);
    expect(reloaded.section('recycleBin').retentionDays).toBe(3);
  });

  test('rejects invalid values', () => {
    t = createTestContext();
    expect(() => t?.ctx.settings.update({ processing: { concurrency: 0 } })).toThrow(AppError);
    expect(t.ctx.settings.section('processing').concurrency).toBe(1);
  });

  test('rejects a relative bdmv root folder path', () => {
    t = createTestContext();
    const settings = t.ctx.settings;
    for (const rootFolderPath of ['movies', '.', '..', './movies']) {
      expect(() => settings.update({ bdmv: { rootFolderPath } })).toThrow(AppError);
    }
    expect(settings.section('bdmv').rootFolderPath).toBeNull();
    expect(settings.update({ bdmv: { rootFolderPath: '/data/movies' } }).bdmv.rootFolderPath).toBe('/data/movies');
    expect(settings.update({ bdmv: { rootFolderPath: null } }).bdmv.rootFolderPath).toBeNull();
  });

  test('keeps valid sections and defaults only the invalid one, logging a warning', () => {
    t = createTestContext();
    t.ctx.settings.update({
      processing: { enabled: true, concurrency: 2 },
      media: { extensions: ['.mkv'] },
      bdmv: { rootFolderPath: '/data/movies' },
    });
    t.ctx.db
      .insert(settingsTable)
      .values({ key: 'recycleBin', value: { retentionDays: 9999 }, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: { retentionDays: 9999 } } })
      .run();
    const warnings: { message: string; data?: LogData }[] = [];
    const ignore = () => undefined;
    const log: Logger = {
      trace: ignore,
      debug: ignore,
      info: ignore,
      warn: (message, data) => warnings.push({ message, data }),
      error: ignore,
      child: () => log,
    };

    const reloaded = new SettingsStore(t.ctx.db, undefined, log);

    expect(reloaded.section('processing')).toMatchObject({ enabled: true, concurrency: 2 });
    expect(reloaded.section('media').extensions).toEqual(['.mkv']);
    expect(reloaded.section('bdmv').rootFolderPath).toBe('/data/movies');
    expect(reloaded.section('recycleBin')).toEqual(DEFAULT_SETTINGS.recycleBin);
    expect(warnings).toEqual([
      {
        message: 'stored settings section invalid, using defaults',
        data: expect.objectContaining({ section: 'recycleBin' }),
      },
    ]);
  });

  test('deepMerge replaces arrays and merges objects', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({
      a: { b: 1, c: [3] },
    });
  });
});
