import type { Settings, SettingsUpdate } from '#lib/shared.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function diff(original: unknown, edited: unknown): unknown {
  if (!isRecord(original) || !isRecord(edited))
    return JSON.stringify(original) === JSON.stringify(edited) ? undefined : edited;
  const entries = Object.keys(edited).flatMap((key) => {
    const change = diff(original[key], edited[key]);
    return change === undefined ? [] : [[key, change] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Deep-partial patch of the changed leaves only (arrays are leaves), so a save never resends values it did not edit. */
export function diffSettings(original: Settings, edited: Settings): SettingsUpdate | null {
  return (diff(original, edited) as SettingsUpdate | undefined) ?? null;
}
