import { expect, test } from 'bun:test';
import { mplsStream } from '../../../test/helpers/mplsStream.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import type { MplsPlaylist, MplsStream } from '../../contracts/bdmv.ts';
import { DEFAULT_SETTINGS } from '../../shared/settings.ts';
import { discLookupName, pickOptions, withPlaylistLanguages } from './planner.ts';

const mpls = (pid: number, kind: MplsStream['kind'], language: string | null): MplsStream =>
  mplsStream(kind, { pid, language });

test('withPlaylistLanguages - MPLS languages win by PID, untagged MPLS streams keep the probe value', () => {
  const probe = probeResult([
    videoStream({ streamId: 0x1011 }),
    audioStream({ streamId: 0x1100, language: null }),
    audioStream({ streamId: 0x1101, language: 'eng' }),
    subtitleStream({ streamId: 0x1200, language: null }),
    subtitleStream({ streamId: null, language: 'fre' }),
  ]);
  const playlist: MplsPlaylist = {
    name: '00800.mpls',
    durationSec: 1,
    playItems: [],
    streams: [
      mpls(0x1011, 'video', 'eng'),
      mpls(0x1100, 'audio', 'spa'),
      mpls(0x1101, 'audio', null),
      mpls(0x1200, 'subtitle', 'eng'),
    ],
    marks: [],
    chapterTimesSec: [],
  };
  expect(withPlaylistLanguages(probe, playlist).streams.map((stream) => stream.language)).toEqual([
    null,
    'spa',
    'eng',
    'eng',
    'fre',
  ]);
});

test.each([
  ['/d/Jamon.Jamon.1992.1080p.BluRay', null, 'Jamon.Jamon.1992.1080p.BluRay'],
  ['/d/Movie.2001.iso', null, 'Movie.2001'],
  ['/d/Heat.1995/BDMV', null, 'Heat.1995'],
  ['/d/Heat.1995/DISC1', null, 'Heat.1995'],
  ['/BDMV', 'HEAT', 'HEAT'],
  ['/BDMV', null, 'BDMV'],
])('discLookupName - %s', (path, label, name) => {
  expect(discLookupName(path, label)).toBe(name);
});

test('pickOptions - extras only when enabled', () => {
  expect(pickOptions(DEFAULT_SETTINGS.bdmv)).toEqual({ ambiguityPercent: 5, extrasMinMinutes: null });
  expect(pickOptions({ ...DEFAULT_SETTINGS.bdmv, extras: { enabled: true, minMinutes: 3 } })).toEqual({
    ambiguityPercent: 5,
    extrasMinMinutes: 3,
  });
});
