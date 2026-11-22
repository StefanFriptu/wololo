import { expect, test } from 'bun:test';
import { PROFILE_TEMPLATE_IDS } from '../../shared/api-types.ts';
import { codecAllowed } from '../rules/engine.ts';
import { ProfileInputSchema } from './ProfileInputSchema.ts';
import { profileTemplates, templateDefinition } from './profileTemplates.ts';

const allowedBy = (id: Parameters<typeof templateDefinition>[0]) => (codec: string) =>
  codecAllowed(codec, templateDefinition(id).audio.allowedCodecs);

test.each([
  ['basic', ['ac3', 'aac', 'mp3'], ['eac3', 'truehd', 'flac', 'pcm_s24le', 'dts']],
  ['dolby', ['ac3', 'eac3', 'truehd'], ['flac', 'alac', 'pcm_s16le', 'dts']],
  ['lossless', ['eac3', 'truehd', 'flac', 'alac', 'pcm_bluray'], ['dts', 'opus']],
  ['everything', ['dts', 'truehd', 'flac', 'pcm_s24le', 'opus', 'vorbis', 'mp2'], []],
  ['blank', ['ac3'], ['aac', 'mp3', 'eac3']],
] as const)('profileTemplates - %s plays %p and converts %p', (id, plays, converts) => {
  expect(plays.filter(allowedBy(id))).toEqual([...plays]);
  expect(converts.filter(allowedBy(id))).toEqual([]);
});

test('profileTemplates - lists every template id once, in order', () => {
  expect(profileTemplates().map((template) => template.id)).toEqual([...PROFILE_TEMPLATE_IDS]);
});

test.each([...PROFILE_TEMPLATE_IDS])('profileTemplates - %s passes profile validation', (id) => {
  const template = profileTemplates().find((candidate) => candidate.id === id);
  expect(ProfileInputSchema.safeParse({ name: template?.name, definition: template?.definition }).success).toBe(true);
});

test('templateDefinition - returns a fresh object on every call', () => {
  const first = templateDefinition('basic');
  first.audio.allowedCodecs.push('dts');
  expect(templateDefinition('basic').audio.allowedCodecs).not.toContain('dts');
});
