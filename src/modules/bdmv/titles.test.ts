import { expect, test } from 'bun:test';
import { writeSup } from '../../../test/fixtures/bdmv/writers.ts';
import type { MplsPlaylist, MplsStream } from '../../contracts/bdmv.ts';
import {
  cleanDiscName,
  countForcedPgsCompositions,
  dedupePlaylists,
  defaultEditionNames,
  detectEncryption,
  hasLoops,
  pickMainTitle,
  playlistNumber,
  titleCandidate,
} from './titles.ts';

function playlist(name: string, clips: readonly (string | [string, number])[], extra: Partial<MplsPlaylist> = {}) {
  const playItems = clips.map((clip) => {
    const [clipId, durationSec] = typeof clip === 'string' ? [clip, 600] : clip;
    return { clipId, inTime: 0, outTime: durationSec * 45_000, durationSec, angleClipIds: [], connectionCondition: 1 };
  });
  return {
    name,
    durationSec: playItems.reduce((sum, item) => sum + item.durationSec, 0),
    playItems,
    streams: [],
    marks: [],
    chapterTimesSec: [],
    ...extra,
  } satisfies MplsPlaylist;
}

const OPTIONS = { ambiguityPercent: 5, extrasMinMinutes: null };

test('dedupePlaylists - keeps the first by name and maps duplicates to it', () => {
  const result = dedupePlaylists([
    playlist('00801.mpls', ['00001', '00002']),
    playlist('00800.mpls', ['00001', '00002']),
    playlist('00802.mpls', ['00002', '00001']),
  ]);
  expect(result.unique.map((p) => p.name)).toEqual(['00800.mpls', '00802.mpls']);
  expect(result.duplicateOf).toEqual({ '00801.mpls': '00800.mpls' });
});

test('dedupePlaylists - same clips with different in/out times are distinct', () => {
  const a = playlist('00001.mpls', ['00001']);
  const b = playlist('00002.mpls', [['00001', 300]]);
  expect(dedupePlaylists([a, b]).unique).toHaveLength(2);
});

test('dedupePlaylists - empty input', () => {
  expect(dedupePlaylists([])).toEqual({ unique: [], duplicateOf: {} });
});

/** Play items as [clipId, inSec, outSec]. */
function ranged(name: string, items: readonly [string, number, number][]): MplsPlaylist {
  const playItems = items.map(([clipId, inSec, outSec]) => ({
    clipId,
    inTime: inSec * 45_000,
    outTime: outSec * 45_000,
    durationSec: outSec - inSec,
    angleClipIds: [],
    connectionCondition: 5,
  }));
  return { ...playlist(name, []), playItems, durationSec: playItems.reduce((sum, item) => sum + item.durationSec, 0) };
}

test.each<[string, [string, number, number][], boolean]>([
  [
    'same clip, same range',
    [
      ['00001', 0, 600],
      ['00001', 0, 600],
    ],
    true,
  ],
  [
    'same clip, overlapping ranges',
    [
      ['00001', 0, 600],
      ['00001', 300, 900],
    ],
    true,
  ],
  [
    'same clip, disjoint ranges (seamless branching)',
    [
      ['00001', 0, 3600],
      ['00002', 0, 300],
      ['00001', 3600, 7200],
    ],
    false,
  ],
  [
    'same clip, touching ranges',
    [
      ['00001', 0, 600],
      ['00001', 600, 1200],
    ],
    false,
  ],
  [
    'different clips',
    [
      ['00001', 0, 600],
      ['00002', 0, 600],
    ],
    false,
  ],
])('hasLoops - %s -> %p', (_label, items, loops) => {
  expect(hasLoops(ranged('00001.mpls', items))).toBe(loops);
});

test('pickMainTitle - a branching cut that reuses one m2ts in two ranges still wins over a short extra', () => {
  const pick = pickMainTitle(
    [
      ranged('00800.mpls', [
        ['00001', 0, 3600],
        ['00002', 0, 1800],
        ['00001', 3600, 7200],
      ]),
      ranged('00801.mpls', [['00003', 0, 1200]]),
    ],
    OPTIONS,
  );
  expect(pick.main?.name).toBe('00800.mpls');
});

test('pickMainTitle - longest unique playlist wins and is not ambiguous', () => {
  const pick = pickMainTitle(
    [
      playlist('00800.mpls', [['00001', 5706]]),
      playlist('00801.mpls', [['00001', 5706]]),
      playlist('00010.mpls', [['00020', 300]]),
    ],
    OPTIONS,
  );
  expect(pick.main?.name).toBe('00800.mpls');
  expect(pick.candidates.map((p) => p.name)).toEqual(['00800.mpls']);
  expect(pick.ambiguous).toBe(false);
  expect(pick.extras).toEqual([]);
});

test('pickMainTitle - multi-clip feature beats a longer single clip only when its total is longer', () => {
  const pick = pickMainTitle(
    [
      playlist('00001.mpls', [['00010', 3000]]),
      playlist('00002.mpls', [
        ['00011', 2000],
        ['00012', 2000],
      ]),
    ],
    OPTIONS,
  );
  expect(pick.main?.name).toBe('00002.mpls');
});

test('pickMainTitle - two cuts within 5% are ambiguous candidates, longest first', () => {
  const pick = pickMainTitle(
    [playlist('00800.mpls', [['00001', 6000]]), playlist('00801.mpls', [['00002', 5800]])],
    OPTIONS,
  );
  expect(pick.main?.name).toBe('00800.mpls');
  expect(pick.candidates.map((p) => p.name)).toEqual(['00800.mpls', '00801.mpls']);
  expect(pick.ambiguous).toBe(true);
});

test.each([
  [5, 5700, true],
  [5, 5699, false],
  [0, 5999, false],
  [10, 5400, true],
])('pickMainTitle - ambiguity %s%% with a %s s second cut -> ambiguous %s', (percent, seconds, ambiguous) => {
  const pick = pickMainTitle(
    [playlist('00800.mpls', [['00001', 6000]]), playlist('00801.mpls', [['00002', seconds]])],
    { ambiguityPercent: percent, extrasMinMinutes: null },
  );
  expect(pick.ambiguous).toBe(ambiguous);
});

test('pickMainTitle - duplicates of the main title are not ambiguous', () => {
  const pick = pickMainTitle(
    [playlist('00800.mpls', [['00001', 6000]]), playlist('00900.mpls', [['00001', 6000]])],
    OPTIONS,
  );
  expect(pick.ambiguous).toBe(false);
});

test('pickMainTitle - looping playlists are ignored when a non-looping one exists', () => {
  const pick = pickMainTitle(
    [
      playlist('00001.mpls', [
        ['00009', 4000],
        ['00009', 4000],
      ]),
      playlist('00800.mpls', [['00001', 6000]]),
    ],
    OPTIONS,
  );
  expect(pick.main?.name).toBe('00800.mpls');
});

test('pickMainTitle - extras longer than the minimum, excluding segments of the feature', () => {
  const pick = pickMainTitle(
    [
      playlist('00800.mpls', [
        ['00001', 3000],
        ['00002', 3000],
      ]),
      playlist('00010.mpls', [['00002', 3000]]),
      playlist('00020.mpls', [['00030', 600]]),
      playlist('00021.mpls', [['00031', 90]]),
    ],
    { ambiguityPercent: 5, extrasMinMinutes: 2 },
  );
  expect(pick.extras.map((p) => p.name)).toEqual(['00020.mpls']);
});

test('pickMainTitle - no playlists or only empty ones', () => {
  expect(pickMainTitle([], OPTIONS)).toEqual({ main: null, candidates: [], extras: [], ambiguous: false });
  expect(pickMainTitle([playlist('00001.mpls', [])], OPTIONS).main).toBeNull();
});

test.each([
  ['decrypted folder', ['BDMV/index.bdmv', 'BDMV/PLAYLIST/00800.mpls', 'CERTIFICATE/id.bdmv'], []],
  [
    'AACS unit key',
    ['AACS/Unit_Key_RO.inf', 'AACS/MKB_RO.inf', 'BDMV/index.bdmv'],
    ['AACS/Unit_Key_RO.inf', 'AACS/MKB_RO.inf'],
  ],
  ['BD+ folder', ['BDSVM/00000.svm', 'BDMV/index.bdmv'], ['BDSVM/']],
  ['BD+ directory entry only', ['BDSVM/'], ['BDSVM/']],
  ['lower case and leading slash', ['/aacs/unit_key_ro.inf'], ['AACS/Unit_Key_RO.inf']],
  ['windows separators', ['AACS\\Unit_Key_RO.inf'], ['AACS/Unit_Key_RO.inf']],
  ['markers below another folder do not count', ['MAKEMKV/AACS/Unit_Key_RO.inf', 'BDMV/index.bdmv'], []],
  ['empty listing', [], []],
] as const)('detectEncryption - %s', (_name, paths, markers) => {
  expect(detectEncryption(paths)).toEqual({ encrypted: markers.length > 0, markers: [...markers] });
});

test.each([
  ['Jamon.Jamon.1992.1080p.BluRay.x264-GRP', 'Jamon Jamon', 1992],
  ['JAMON_JAMON', 'Jamon Jamon', null],
  ['Jamón Jamón (1992)', 'Jamón Jamón', 1992],
  ['Blade.Runner.2049.2017.COMPLETE.UHD.BLURAY-GRP', 'Blade Runner 2049', 2017],
  ['1917.2019.2160p.UHD.BluRay', '1917', 2019],
  ['2001.A.Space.Odyssey.1968.BluRay', '2001 A Space Odyssey', 1968],
  ['Spider-Man.2002.1080p.BluRay', 'Spider-Man', 2002],
  ['Movie Title [1080p] BluRay', 'Movie Title', null],
  ['The.Matrix.1999.iso', 'The Matrix', 1999],
  ['THE_MATRIX_DISC1', 'The Matrix', null],
  ['Heat 1995 Remux', 'Heat', 1995],
  ['BDMV', 'Bdmv', null],
])('cleanDiscName - %s', (name, title, year) => {
  expect(cleanDiscName(name)).toEqual({ title, year });
});

test('countForcedPgsCompositions - counts shown compositions and forced ones', () => {
  const sup = writeSup([
    { objects: [{ forced: true }] },
    { objects: [] },
    { objects: [{ forced: false }] },
    { objects: [{ forced: false, cropped: true }, { forced: true }] },
  ]);
  expect(countForcedPgsCompositions(sup)).toEqual({ compositions: 3, forced: 2 });
});

test('countForcedPgsCompositions - all forced', () => {
  const sup = writeSup([{ objects: [{ forced: true }] }, { objects: [{ forced: true, cropped: true }] }]);
  expect(countForcedPgsCompositions(sup)).toEqual({ compositions: 2, forced: 2 });
});

test('countForcedPgsCompositions - empty and garbage input', () => {
  expect(countForcedPgsCompositions(new Uint8Array())).toEqual({ compositions: 0, forced: 0 });
  expect(countForcedPgsCompositions(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toEqual({
    compositions: 0,
    forced: 0,
  });
});

test('countForcedPgsCompositions - truncated trailing segment is ignored', () => {
  const sup = writeSup([{ objects: [{ forced: true }] }, { objects: [{ forced: true }] }]);
  expect(countForcedPgsCompositions(sup.subarray(0, sup.length - 20))).toEqual({ compositions: 1, forced: 1 });
});

const stream = (kind: MplsStream['kind'], language: string | null): MplsStream => ({
  kind,
  pid: 0,
  codingType: 0,
  codec: '',
  language,
  secondaryVideo: false,
});

test('titleCandidate - summarises clips, chapters and unique languages', () => {
  const candidate = titleCandidate(
    playlist('00800.mpls', ['00001', '00002'], {
      chapterTimesSec: [0, 300, 600],
      streams: [
        stream('video', null),
        stream('audio', 'spa'),
        stream('audio', 'spa'),
        stream('audio', null),
        stream('subtitle', 'eng'),
      ],
    }),
  );
  expect(candidate).toEqual({
    playlist: '00800.mpls',
    durationSec: 1200,
    clips: ['00001', '00002'],
    chapterCount: 3,
    audioLanguages: ['spa'],
    subtitleLanguages: ['eng'],
  });
});

test.each([
  [[['a', 100]], { a: 'Theatrical' }],
  [
    [
      ['a', 120],
      ['b', 100],
    ],
    { b: 'Theatrical', a: 'Extended' },
  ],
  [
    [
      ['a', 100],
      ['b', 110],
      ['c', 120],
    ],
    { a: 'Theatrical', b: 'Cut 2', c: 'Extended' },
  ],
] as const)('defaultEditionNames - %j', (input, expected) => {
  expect(defaultEditionNames(input.map(([name, durationSec]) => ({ name, durationSec })))).toEqual(expected);
});

test.each([
  ['00800.mpls', 800],
  ['00000.MPLS', 0],
  ['12345.mpls', 12345],
])('playlistNumber - %s', (name, number) => {
  expect(playlistNumber(name)).toBe(number);
});

test('playlistNumber - rejects other names', () => {
  expect(() => playlistNumber('index.bdmv')).toThrow('not a playlist');
});
