import { expect, test } from 'bun:test';
import type { CodecInfo } from '#lib/shared.ts';
import { codecAllowedBy } from './codecAllowedBy.ts';
import { partitionCodecs } from './partitionCodecs.ts';

const info = (codec: string): CodecInfo => ({ codec, label: codec.toUpperCase(), kind: 'audio', lossless: false });

test('partitionCodecs - splits catalog codecs from custom entries in their original order', () => {
  expect(partitionCodecs(['ac3', 'pcm_*', 'aac', 'mp2'], [info('aac'), info('ac3'), info('dts')])).toEqual({
    known: ['ac3', 'aac'],
    custom: ['pcm_*', 'mp2'],
  });
});

test('partitionCodecs - empty allowed list', () => {
  expect(partitionCodecs([], [info('ac3')])).toEqual({ known: [], custom: [] });
});

test.each([
  [['ac3', 'aac'], 'ac3', true],
  [['ac3', 'aac'], 'eac3', false],
  [['pcm_*'], 'pcm_s24le', true],
  [['pcm_*'], 'flac', false],
  [['*'], 'anything', true],
  [[], 'ac3', false],
])('codecAllowedBy - %p allows %p: %p', (allowed, codec, expected) => {
  expect(codecAllowedBy(allowed, codec)).toBe(expected);
});
