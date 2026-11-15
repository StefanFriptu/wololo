import { expect, test } from 'bun:test';
import { codecAllowed } from '../rules/engine.ts';
import { samsungTizenDefinition } from './defaults.ts';
import { ProfileInputSchema } from './ProfileInputSchema.ts';

test.each([
  ['dts', false],
  ['truehd', false],
  ['eac3', false],
  ['pcm_s16le', false],
  ['pcm_s24le', false],
  ['pcm_bluray', false],
  ['flac', false],
  ['opus', false],
  ['vorbis', false],
  ['ac3', true],
  ['aac', true],
  ['mp3', true],
])('samsungTizenDefinition - %s decoded natively: %p', (codec, allowed) => {
  expect(codecAllowed(codec, samsungTizenDefinition().audio.allowedCodecs)).toBe(allowed);
});

test('samsungTizenDefinition - targets ac3 at 640/448/192 kbps with a 5.1 ceiling', () => {
  expect(samsungTizenDefinition().audio).toMatchObject({
    targetCodec: 'ac3',
    bitrates: { mono: 192, stereo: 448, surround: 640 },
    maxChannels: 6,
  });
});

test('samsungTizenDefinition - passes profile validation', () => {
  expect(ProfileInputSchema.safeParse({ name: 'Samsung Tizen', definition: samsungTizenDefinition() }).success).toBe(
    true,
  );
});

test('samsungTizenDefinition - returns a fresh object on every call', () => {
  const first = samsungTizenDefinition();
  first.audio.allowedCodecs.push('dts');
  expect(samsungTizenDefinition().audio.allowedCodecs).not.toContain('dts');
});
