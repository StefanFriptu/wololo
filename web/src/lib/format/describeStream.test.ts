import { expect, test } from 'bun:test';
import { audioStream, subtitleStream, videoStream } from '../../../../test/helpers/probe.ts';
import { describeStream } from './describeStream.ts';

test('describeStream - audio uses the profile, layout, sample rate, object audio and bit rate', () => {
  const stream = audioStream({
    codec: 'truehd',
    profile: 'Dolby TrueHD + Dolby Atmos',
    channels: 8,
    objectAudio: 'atmos',
    bitRate: 4_512_000,
    forced: false,
  });
  expect(describeStream(stream)).toEqual({
    codec: 'Dolby TrueHD + Dolby Atmos',
    details: '7.1 · 48 kHz · Atmos · 4512 kbps',
    language: 'eng',
    flags: ['default'],
  });
});

test('describeStream - audio without profile upper-cases the codec', () => {
  expect(describeStream(audioStream({ codec: 'ac3', channels: 2, default: false })).codec).toBe('AC3');
});

test('describeStream - video lists resolution, frame rate, bit depth and HDR', () => {
  const stream = videoStream({
    codec: 'hevc',
    profile: 'Main 10',
    width: 3840,
    height: 2160,
    bitDepth: 10,
    hdr: 'hdr10',
  });
  const description = describeStream(stream);
  expect(description.codec).toBe('HEVC');
  expect(description.details).toBe('3840x2160 · 23.976 fps · 10-bit · HDR10');
});

test('describeStream - Dolby Vision shows the profile instead of the HDR label', () => {
  const stream = videoStream({
    hdr: 'dolby_vision',
    dolbyVision: {
      profile: 7,
      level: 6,
      rpuPresent: true,
      elPresent: true,
      blPresent: true,
      blSignalCompatibilityId: 6,
    },
  });
  expect(describeStream(stream).details).toContain('DV profile 7');
});

test('describeStream - subtitle shows image or text, SDH, title and forced flag', () => {
  const stream = subtitleStream({
    codec: 'hdmv_pgs_subtitle',
    bitmap: true,
    hearingImpaired: true,
    forced: true,
    title: 'Signs',
    language: null,
  });
  expect(describeStream(stream)).toEqual({
    codec: 'HDMV_PGS_SUBTITLE',
    details: 'image · SDH · "Signs"',
    language: 'und',
    flags: ['forced'],
  });
});

test('describeStream - attachment shows file name and mime type', () => {
  const description = describeStream({
    ...subtitleStream(),
    kind: 'attachment',
    codec: 'ttf',
    filename: 'font.ttf',
    mimeType: 'font/ttf',
  });
  expect(description.details).toBe('font.ttf · font/ttf');
});
