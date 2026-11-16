import { expect, test } from 'bun:test';
import type { ConversionPlan, PlannedStream } from '#lib/shared.ts';
import { audioStream, subtitleStream, videoStream } from '../../../../test/helpers/probe.ts';
import { pairStreams } from './pairStreams.ts';

const video = videoStream({ index: 0 });
const dts = audioStream({ index: 1, codec: 'dts', profile: 'DTS-HD MA' });
const ac3 = audioStream({ index: 2, codec: 'ac3', language: 'ger' });
const subs = subtitleStream({ index: 3, language: null });

const planned = (overrides: Partial<PlannedStream> & Pick<PlannedStream, 'sourceIndex' | 'kind'>): PlannedStream => ({
  op: 'copy',
  codec: 'copy',
  encode: null,
  language: null,
  retagged: false,
  title: null,
  default: false,
  forced: false,
  ...overrides,
});

const plan = (overrides: Partial<ConversionPlan> = {}): ConversionPlan => ({
  action: 'convert',
  reasons: [],
  failingCodecs: ['dts'],
  streams: [
    planned({ sourceIndex: 0, kind: 'video' }),
    planned({ sourceIndex: 1, kind: 'audio', op: 'encode', codec: 'ac3' }),
    planned({ sourceIndex: 3, kind: 'subtitle', retagged: true, language: 'eng' }),
  ],
  dropped: [{ sourceIndex: 2, kind: 'audio', codec: 'ac3', language: 'ger', reason: 'language_filter' }],
  lostFeatures: [],
  videoNotes: [],
  estimatedOutputBytes: null,
  rulesKey: '1@1',
  ...overrides,
});

test('pairStreams - plan rows follow output order and end with dropped sources', () => {
  const rows = pairStreams({ before: [video, dts, ac3, subs], plan: plan() });
  expect(rows.map((row) => [row.kind, row.before?.index ?? null, row.change, row.dropReason])).toEqual([
    ['video', 0, 'copy', null],
    ['audio', 1, 'encode', null],
    ['subtitle', 3, 'retag', null],
    ['audio', 2, 'drop', 'language_filter'],
  ]);
});

test('pairStreams - a source replaced by its converted track is listed once', () => {
  const replaced = plan({
    streams: [
      planned({ sourceIndex: 0, kind: 'video' }),
      planned({ sourceIndex: 1, kind: 'audio', op: 'encode', codec: 'ac3' }),
    ],
    dropped: [{ sourceIndex: 1, kind: 'audio', codec: 'dts', language: 'eng', reason: 'incompatible_replaced' }],
  });
  const rows = pairStreams({ before: [video, dts], plan: replaced });
  expect(rows.map((row) => [row.before?.index ?? null, row.change])).toEqual([
    [0, 'copy'],
    [1, 'encode'],
  ]);
});

test('pairStreams - a replaced drop without its encoded track stays listed', () => {
  const orphan = plan({
    streams: [planned({ sourceIndex: 0, kind: 'video' })],
    dropped: [{ sourceIndex: 1, kind: 'audio', codec: 'dts', language: 'eng', reason: 'incompatible_replaced' }],
  });
  const rows = pairStreams({ before: [video, dts], plan: orphan });
  expect(rows.map((row) => [row.before?.index ?? null, row.change])).toEqual([
    [0, 'copy'],
    [1, 'drop'],
  ]);
});

test('pairStreams - written streams are matched by output position', () => {
  const written = [videoStream({ index: 0 }), audioStream({ index: 1, codec: 'ac3' }), subtitleStream({ index: 2 })];
  const rows = pairStreams({ before: [video, dts, ac3, subs], plan: plan(), after: written });
  expect(rows.map((row) => row.after?.codec ?? null)).toEqual(['h264', 'ac3', 'subrip', null]);
});

test('pairStreams - a written stream of another kind is not paired', () => {
  const rows = pairStreams({ before: [video, dts], plan: plan(), after: [videoStream(), subtitleStream()] });
  expect(rows[1]?.after).toBeNull();
});

test('pairStreams - a planned source missing from the probe yields a null before', () => {
  const rows = pairStreams({ before: [video], plan: plan() });
  expect(rows[1]?.before).toBeNull();
  expect(rows[1]?.planned?.op).toBe('encode');
});

test('pairStreams - without plan or written file every stream is listed unchanged', () => {
  const rows = pairStreams({ before: [video, dts], plan: null });
  expect(rows.map((row) => row.change)).toEqual(['none', 'none']);
});

test('pairStreams - without plan, written streams pair by position', () => {
  const rows = pairStreams({
    before: [video, dts, ac3],
    plan: null,
    after: [videoStream(), audioStream({ codec: 'ac3' })],
  });
  expect(rows.map((row) => row.change)).toEqual(['copy', 'encode', 'drop']);
});

test('pairStreams - extra written streams are additions', () => {
  const rows = pairStreams({ before: [video], plan: null, after: [videoStream(), audioStream()] });
  expect(rows.map((row) => row.change)).toEqual(['copy', 'add']);
});

test('pairStreams - no streams at all yields no rows', () => {
  expect(pairStreams({ before: null, plan: null })).toEqual([]);
});

test('pairStreams - a blocked plan without planned or dropped streams still lists the source streams', () => {
  const rows = pairStreams({ before: [video, dts], plan: plan({ action: 'blocked', streams: [], dropped: [] }) });
  expect(rows.map((row) => [row.before?.index, row.change])).toEqual([
    [0, 'none'],
    [1, 'none'],
  ]);
});
