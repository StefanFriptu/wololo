import type { BdmvDecisionChoice } from '#lib/shared.ts';

interface MainTitleSelection {
  playlists: readonly string[];
  asEditions: boolean;
  editionNames: Readonly<Record<string, string>>;
}

type MainTitleResult =
  | { ok: true; choice: Extract<BdmvDecisionChoice, { kind: 'main_title' }> }
  | { ok: false; reason: string };

/** Validates the main-title form: one playlist, or two or more named Plex editions. */
export function mainTitleChoice({ playlists, asEditions, editionNames }: MainTitleSelection): MainTitleResult {
  const chosen = [...new Set(playlists)];
  if (chosen.length === 0) return { ok: false, reason: 'Choose a playlist.' };
  if (!asEditions) {
    if (chosen.length > 1) return { ok: false, reason: 'Choose one playlist, or export them as editions.' };
    return { ok: true, choice: { kind: 'main_title', playlists: chosen, asEditions: false, editionNames: {} } };
  }
  if (chosen.length < 2) return { ok: false, reason: 'Editions need at least two playlists.' };
  const names = Object.fromEntries(chosen.map((playlist) => [playlist, editionNames[playlist]?.trim() ?? '']));
  const unnamed = chosen.filter((playlist) => names[playlist] === '');
  if (unnamed.length > 0) return { ok: false, reason: `Name the edition for ${unnamed.join(', ')}.` };
  const distinct = new Set(Object.values(names).map((name) => name.toLowerCase()));
  if (distinct.size < chosen.length) return { ok: false, reason: 'Each edition needs a different name.' };
  return { ok: true, choice: { kind: 'main_title', playlists: chosen, asEditions: true, editionNames: names } };
}
