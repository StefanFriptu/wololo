import { expect, test } from 'bun:test';
import type { ProfileTemplate, ProfileTemplateId } from '#lib/shared.ts';
import { defaultTemplate } from './defaultTemplate.ts';

const template = (id: ProfileTemplateId): ProfileTemplate => ({
  id,
  name: id,
  description: '',
  definition: {
    audio: {
      allowedCodecs: [],
      targetCodec: 'ac3',
      bitrates: { mono: 192, stereo: 448, surround: 640 },
      maxChannels: 6,
    },
    video: { allowedCodecs: [], dolbyVision: 'drop_hdr10' },
    subtitles: { allowedCodecs: [] },
    container: 'mkv',
  },
});

test('defaultTemplate - prefers Dolby wherever it sits in the list', () => {
  expect(defaultTemplate([template('basic'), template('dolby')])?.id).toBe('dolby');
});

test('defaultTemplate - falls back to the first template when Dolby is missing', () => {
  expect(defaultTemplate([template('lossless'), template('blank')])?.id).toBe('lossless');
});

test('defaultTemplate - no templates gives nothing', () => {
  expect(defaultTemplate([])).toBeUndefined();
});
