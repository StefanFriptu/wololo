import { expect, test } from 'bun:test';
import { dryRunGroupKeys, type GroupableRow } from './dryRunGroups.ts';

test.each<[string, GroupableRow, string[]]>([
  ['one failing codec', { kind: 'file', planAction: 'convert', failingCodecs: ['dts'], videoCodec: 'h264' }, ['dts']],
  [
    'several failing codecs, deduplicated',
    { kind: 'file', planAction: 'convert', failingCodecs: ['DTS', 'truehd', 'dts'], videoCodec: 'h264' },
    ['dts', 'truehd'],
  ],
  [
    'remux without failing codec',
    { kind: 'file', planAction: 'remux', failingCodecs: [], videoCodec: 'h264' },
    ['remux'],
  ],
  ['disc', { kind: 'bdmv', planAction: 'remux', failingCodecs: ['bdmv'], videoCodec: null }, ['bdmv']],
  ['iso', { kind: 'iso', planAction: 'convert', failingCodecs: [], videoCodec: null }, ['bdmv']],
  [
    'blocked names the video codec',
    { kind: 'file', planAction: 'blocked', failingCodecs: ['vc1', 'dts'], videoCodec: 'vc1' },
    ['video:vc1', 'dts'],
  ],
  [
    'blocked without failing codecs falls back to the video codec',
    { kind: 'file', planAction: 'blocked', failingCodecs: [], videoCodec: 'mpeg2video' },
    ['video:mpeg2video'],
  ],
  [
    'blocked with nothing known',
    { kind: 'file', planAction: 'blocked', failingCodecs: [], videoCodec: null },
    ['blocked'],
  ],
])('dryRunGroupKeys - %s', (_label, row, expected) => {
  expect(dryRunGroupKeys(row)).toEqual(expected);
});
