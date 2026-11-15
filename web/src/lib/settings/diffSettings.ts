import type { Settings, SettingsSection, SettingsUpdate } from '#lib/shared.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Patch for PUT /api/v1/settings: every section that changed, sent whole; null when nothing changed. */
export function diffSettings(original: Settings, edited: Settings): SettingsUpdate | null {
  const changed = (Object.keys(edited) as SettingsSection[]).filter(
    (section) => !same(original[section], edited[section]),
  );
  if (changed.length === 0) return null;
  return Object.fromEntries(changed.map((section) => [section, edited[section]])) as SettingsUpdate;
}
