import { expect, test } from 'bun:test';
import { AC3_MAX_KBPS, codecAllowed, MAX_AUDIO_KBPS, maxBitrateKbps } from '../../src/shared/audioRules.ts';
import { TARGET_AUDIO_CODECS } from '../../src/shared/domain.ts';

test.each([
  ['ac3', ['ac3', 'aac'], true],
  ['AC3', ['ac3'], true],
  ['ac3', ['AC3'], true],
  ['dts', ['ac3', 'aac', 'mp3'], false],
  ['eac3', ['ac3'], false],
  ['pcm_s24le', ['pcm_*'], true],
  ['pcm_bluray', ['ac3', 'pcm_*'], true],
  ['PCM_S24LE', ['pcm_*'], true],
  ['flac', ['pcm_*'], false],
  ['ac3', [], false],
  ['vorbis', ['*'], true],
] as const)('codecAllowed - %s against %j is %p', (codec, allowed, expected) => {
  expect(codecAllowed(codec, allowed)).toBe(expected);
});

test.each([
  ['ac3', 640],
  ['eac3', 1536],
  ['aac', 1536],
] as const)('maxBitrateKbps - %s allows up to %d kbps', (target, expected) => {
  expect(maxBitrateKbps(target)).toBe(expected);
});

test('audio limits - the AC3 cap is below the overall cap and every target has a limit', () => {
  expect(AC3_MAX_KBPS).toBeLessThan(MAX_AUDIO_KBPS);
  expect(TARGET_AUDIO_CODECS.map(maxBitrateKbps).every((kbps) => kbps > 0)).toBe(true);
});
