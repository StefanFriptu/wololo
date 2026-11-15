/** Builders for the typed stream model, so tests do not depend on parseFfprobeOutput or real files. */
import type { AudioStream, MediaStream, ProbeResult, SubtitleStream, VideoStream } from '../../src/shared/domain.ts';

const base = (index: number) => ({
  index,
  streamId: null,
  startTimeSec: 0,
  codecLongName: null,
  profile: null,
  language: null,
  title: null,
  default: false,
  forced: false,
  bitRate: null,
  durationSec: null,
});

export function videoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    ...base(0),
    kind: 'video',
    codec: 'h264',
    width: 1920,
    height: 1080,
    frameRate: 23.976,
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    hdr: 'sdr',
    dolbyVision: null,
    attachedPicture: false,
    stereo3d: false,
    default: true,
    ...overrides,
  };
}

const LAYOUTS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1(side)', 8: '7.1' };
const LOSSLESS = new Set(['truehd', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray', 'mlp']);

export function audioStream(overrides: Partial<AudioStream> = {}): AudioStream {
  const codec = overrides.codec ?? 'dts';
  const channels = overrides.channels ?? 6;
  return {
    ...base(1),
    kind: 'audio',
    codec,
    language: 'eng',
    channels,
    channelLayout: LAYOUTS[channels] ?? null,
    sampleRate: 48000,
    bitsPerSample: null,
    objectAudio: null,
    lossless: LOSSLESS.has(codec) || overrides.profile === 'DTS-HD MA',
    default: true,
    ...overrides,
  };
}

export function subtitleStream(overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    ...base(2),
    kind: 'subtitle',
    codec: 'subrip',
    language: 'eng',
    bitmap: false,
    hearingImpaired: false,
    ...overrides,
  };
}

/** Streams are re-indexed in array order (index = position). */
export function probeResult(streams: MediaStream[], overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    path: '/data/media/movies/Movie (2020)/Movie (2020).mkv',
    formatName: 'matroska,webm',
    durationSec: 5400,
    sizeBytes: 8_000_000_000,
    bitRate: null,
    chapterCount: 0,
    streams: streams.map((stream, index) => ({ ...stream, index })),
    tags: {},
    probedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
