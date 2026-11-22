import type {
  CleanDiscName,
  CountForcedPgsCompositions,
  DedupePlaylists,
  DetectEncryption,
  MplsPlaylist,
  PickMainTitle,
} from '../../contracts/bdmv.ts';
import type { BdmvTitleCandidate, Iso639_2 } from '../../shared/domain.ts';

function clipSignature(playlist: MplsPlaylist): string {
  return playlist.playItems
    .map((item) => `${item.clipId}:${item.inTime}:${item.outTime}:${item.angleClipIds.join('+')}`)
    .join('|');
}

const byName = (a: MplsPlaylist, b: MplsPlaylist) => a.name.localeCompare(b.name);

export const dedupePlaylists: DedupePlaylists = (playlists) => {
  const firstBySignature = new Map<string, string>();
  const unique: MplsPlaylist[] = [];
  const duplicateOf: Record<string, string> = {};
  for (const playlist of [...playlists].sort(byName)) {
    const signature = clipSignature(playlist);
    const kept = firstBySignature.get(signature);
    if (kept !== undefined) {
      duplicateOf[playlist.name] = kept;
      continue;
    }
    firstBySignature.set(signature, playlist.name);
    unique.push(playlist);
  }
  return { unique, duplicateOf };
};

/**
 * A playlist that plays the same part of a clip twice is a menu/background loop (BDInfo's "filter looping playlists").
 * Disjoint ranges of one clip are seamless branching (an extended cut reusing the feature m2ts), not a loop.
 */
export function hasLoops(playlist: MplsPlaylist): boolean {
  const items = playlist.playItems;
  return items.some((a, i) =>
    items
      .slice(i + 1)
      .some(
        (b) =>
          a.clipId === b.clipId &&
          ((a.inTime === b.inTime && a.outTime === b.outTime) || (a.inTime < b.outTime && b.inTime < a.outTime)),
      ),
  );
}

const byDurationDesc = (a: MplsPlaylist, b: MplsPlaylist) => b.durationSec - a.durationSec || byName(a, b);

export const pickMainTitle: PickMainTitle = (playlists, options) => {
  const { unique } = dedupePlaylists(playlists);
  const playable = unique.filter((playlist) => playlist.durationSec > 0);
  const withoutLoops = playable.filter((playlist) => !hasLoops(playlist));
  const pool = (withoutLoops.length > 0 ? withoutLoops : playable).sort(byDurationDesc);
  const main = pool[0] ?? null;
  if (!main) return { main: null, candidates: [], extras: [], ambiguous: false };

  const threshold = main.durationSec * (1 - options.ambiguityPercent / 100);
  const candidates = pool.filter((playlist) => playlist.durationSec >= threshold);
  const candidateNames = new Set(candidates.map((playlist) => playlist.name));
  const featureClips = new Set(candidates.flatMap((playlist) => playlist.playItems.map((item) => item.clipId)));
  const extras =
    options.extrasMinMinutes === null
      ? []
      : pool.filter(
          (playlist) =>
            !candidateNames.has(playlist.name) &&
            playlist.durationSec >= (options.extrasMinMinutes ?? 0) * 60 &&
            !playlist.playItems.every((item) => featureClips.has(item.clipId)),
        );
  return { main, candidates, extras, ambiguous: candidates.length > 1 };
};

const ENCRYPTION_MARKERS: readonly { marker: string; matches: (path: string) => boolean }[] = [
  { marker: 'AACS/Unit_Key_RO.inf', matches: (path) => path === 'aacs/unit_key_ro.inf' },
  { marker: 'AACS/MKB_RO.inf', matches: (path) => path === 'aacs/mkb_ro.inf' },
  { marker: 'BDSVM/', matches: (path) => path === 'bdsvm' || path.startsWith('bdsvm/') },
];

/** Only root-level AACS/ and BDSVM/ count, as in libbluray's detection; copies below other folders do not. */
export const detectEncryption: DetectEncryption = (relativePaths) => {
  const normalized = relativePaths.map((path) =>
    path
      .replaceAll('\\', '/')
      .replace(/^(\.\/|\/)+/, '')
      .replace(/\/+$/, '')
      .toLowerCase(),
  );
  const markers = ENCRYPTION_MARKERS.filter(({ matches }) => normalized.some(matches)).map(({ marker }) => marker);
  return { encrypted: markers.length > 0, markers };
};

const RELEASE_TOKENS = new Set([
  '2160p',
  '1080p',
  '1080i',
  '720p',
  '576p',
  '480p',
  '4k',
  'uhd',
  'bluray',
  'blu-ray',
  'bdrip',
  'brrip',
  'bdremux',
  'remux',
  'bd25',
  'bd50',
  'bd66',
  'bd100',
  'bdmv',
  'complete',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'vc1',
  'mpeg2',
  'hdr',
  'hdr10',
  'dv',
  'dts',
  'truehd',
  'atmos',
  'ac3',
  'multi',
  'proper',
  'repack',
  'iso',
]);

const YEAR = /^(19\d{2}|20\d{2})$/;

function titleCase(words: readonly string[]): string {
  const shouting = words.every((word) => word === word.toUpperCase());
  if (!shouting) return words.join(' ');
  return words.map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
}

export const cleanDiscName: CleanDiscName = (name) => {
  const tokens = name
    .replace(/\.iso$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[(){}]/g, ' ')
    .split(/[\s._]+/)
    .filter(Boolean);
  const yearIndex = tokens.findLastIndex((token, i) => i > 0 && YEAR.test(token));
  const releaseIndex = tokens.findIndex(
    (token, i) => i > 0 && RELEASE_TOKENS.has(token.toLowerCase().split('-')[0] ?? ''),
  );
  const cut = [yearIndex, releaseIndex].filter((i) => i > 0);
  const end = cut.length > 0 ? Math.min(...cut) : tokens.length;
  const words = tokens.slice(0, end).filter((token) => !/^disc\d*$|^d\d$/i.test(token));
  return {
    title: titleCase(words.length > 0 ? words : tokens.slice(0, 1)),
    year: yearIndex > 0 ? Number(tokens[yearIndex]) : null,
  };
};

const PGS_HEADER_SIZE = 13;
const PGS_PRESENTATION_COMPOSITION = 0x16;
const PGS_OBJECT_CROPPED = 0x80;
const PGS_OBJECT_FORCED = 0x40;

/** Counts presentation composition segments that show objects; a composition is forced when any object is forced. */
export const countForcedPgsCompositions: CountForcedPgsCompositions = (sup) => {
  const view = new DataView(sup.buffer, sup.byteOffset, sup.byteLength);
  let compositions = 0;
  let forced = 0;
  let offset = 0;
  while (offset + PGS_HEADER_SIZE <= sup.byteLength && sup[offset] === 0x50 && sup[offset + 1] === 0x47) {
    const type = view.getUint8(offset + 10);
    const size = view.getUint16(offset + 11);
    const data = offset + PGS_HEADER_SIZE;
    offset = data + size;
    if (type !== PGS_PRESENTATION_COMPOSITION || size < 11 || offset > sup.byteLength) continue;
    const objectCount = view.getUint8(data + 10);
    if (objectCount === 0) continue;
    compositions += 1;
    let object = data + 11;
    let anyForced = false;
    for (let i = 0; i < objectCount && object + 8 <= offset; i++) {
      const flags = view.getUint8(object + 3);
      anyForced ||= (flags & PGS_OBJECT_FORCED) !== 0;
      object += flags & PGS_OBJECT_CROPPED ? 16 : 8;
    }
    if (anyForced) forced += 1;
  }
  return { compositions, forced };
};

function languagesOf(playlist: MplsPlaylist, kind: 'audio' | 'subtitle'): Iso639_2[] {
  const languages = playlist.streams.filter((stream) => stream.kind === kind).map((stream) => stream.language);
  return [...new Set(languages.filter((language): language is Iso639_2 => language !== null))];
}

export function titleCandidate(playlist: MplsPlaylist): BdmvTitleCandidate {
  return {
    playlist: playlist.name,
    durationSec: playlist.durationSec,
    clips: playlist.playItems.map((item) => item.clipId),
    chapterCount: playlist.chapterTimesSec.length,
    audioLanguages: languagesOf(playlist, 'audio'),
    subtitleLanguages: languagesOf(playlist, 'subtitle'),
  };
}

/** Plex edition names for cuts of different length: shortest "Theatrical", longest "Extended", others "Cut N". */
export function defaultEditionNames(
  playlists: readonly Pick<MplsPlaylist, 'name' | 'durationSec'>[],
): Record<string, string> {
  const sorted = [...playlists].sort((a, b) => a.durationSec - b.durationSec || a.name.localeCompare(b.name));
  const names: Record<string, string> = {};
  sorted.forEach((playlist, i) => {
    if (i === 0) names[playlist.name] = 'Theatrical';
    else if (i === sorted.length - 1) names[playlist.name] = 'Extended';
    else names[playlist.name] = `Cut ${i + 1}`;
  });
  return names;
}
