import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { settings as settingsTable } from '../db/schema.ts';
import { DEFAULT_SETTINGS, type DeepPartial, type Settings, type SettingsSection } from '../shared/settings.ts';
import { AppError } from './errors.ts';
import type { EventBus } from './events.ts';
import type { Logger } from './logger.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

export const settingsSchema = z.object({
  processing: z.object({
    enabled: z.boolean(),
    paused: z.boolean(),
    concurrency: z.number().int().min(1).max(8),
    niceLevel: z.number().int().min(0).max(19),
    ioniceClass: z.enum(['idle', 'best-effort']),
    window: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
    estimatedSpeedFactor: z.number().positive().max(1000),
    freeSpaceMarginPercent: z.number().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(10),
  }),
  media: z.object({
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)),
    ignorePatterns: z.array(z.string().min(1)),
    checkOnImport: z.boolean(),
  }),
  recycleBin: z.object({
    enabled: z.boolean(),
    retentionDays: z.number().int().min(0).max(365),
    path: z.string().min(1).refine(isAbsolute, 'must be an absolute path').nullable(),
  }),
  bdmv: z.object({
    enabled: z.boolean(),
    ambiguityPercent: z.number().min(0).max(50),
    onAmbiguous: z.enum(['ask', 'editions']),
    minMatchScore: z.number().min(0).max(1),
    extras: z.object({
      enabled: z.boolean(),
      minMinutes: z.number().min(0).max(600),
    }),
    deleteSourceWhenSeeded: z.boolean(),
    rootFolderPath: z.string().min(1).refine(isAbsolute, 'must be an absolute path').nullable(),
    qualityProfileId: z.number().int().positive().nullable(),
  }),
  notifications: z.object({
    rescanArr: z.boolean(),
  }),
}) satisfies z.ZodType<Settings>;

const SECTIONS = Object.keys(DEFAULT_SETTINGS) as SettingsSection[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

/** Typed runtime settings backed by the settings KV table (one JSON row per section), cached in memory. */
export class SettingsStore {
  private cache: Settings;

  constructor(
    private readonly db: Db,
    private readonly events?: EventBus,
    private readonly log?: Logger,
  ) {
    this.cache = this.load();
  }

  get(): Settings {
    return this.cache;
  }

  section<K extends SettingsSection>(key: K): Settings[K] {
    return this.cache[key];
  }

  update(patch: DeepPartial<Settings>): Settings {
    const merged = deepMerge(this.cache, patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) throw new AppError('validation', 'invalid settings', z.treeifyError(parsed.error));
    const changed = SECTIONS.filter((key) => JSON.stringify(parsed.data[key]) !== JSON.stringify(this.cache[key]));
    if (changed.length === 0) return this.cache;

    const updatedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const key of changed) {
        tx.insert(settingsTable)
          .values({ key, value: parsed.data[key], updatedAt })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: parsed.data[key], updatedAt },
          })
          .run();
      }
    });
    this.cache = parsed.data;
    this.events?.emit('settings.changed', { sections: changed });
    return this.cache;
  }

  private loadSection(key: SettingsSection, stored: unknown): unknown {
    const defaults = structuredClone(DEFAULT_SETTINGS[key]);
    if (stored === undefined) return defaults;
    const schema: z.ZodType = settingsSchema.shape[key];
    const parsed = schema.safeParse(deepMerge(defaults, stored));
    if (parsed.success) return parsed.data;
    this.log?.warn('stored settings section invalid, using defaults', {
      section: key,
      issues: z.treeifyError(parsed.error),
    });
    return defaults;
  }

  private load(): Settings {
    const rows = this.db.select().from(settingsTable).all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return settingsSchema.parse(
      Object.fromEntries(SECTIONS.map((key) => [key, this.loadSection(key, stored.get(key))])),
    );
  }
}
