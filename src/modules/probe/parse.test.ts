import { expect, test } from 'bun:test';
import { AppError } from '../../core/errors.ts';
import type { AudioStream, MediaStream, OtherStream, SubtitleStream, VideoStream } from '../../shared/domain.ts';
import { parseFfprobeOutput } from './parse.ts';

const PROBED_AT = '2026-11-15T10:00:00.000Z';

function parseStream(raw: Record<string, unknown>): MediaStream {
  const result = parseFfprobeOutput({ streams: [{ index: 0, ...raw }] }, '/m/a.mkv', 1000, PROBED_AT);
  const [stream] = result.streams;
  if (!stream) throw new Error('no stream parsed');
  return stream;
}

const disposition = (flags: Record<string, number> = {}) => ({
  default: 0,
  forced: 0,
  hearing_impaired: 0,
  attached_pic: 0,
  ...flags,
});

test('parseFfprobeOutput - maps format fields, tags and chapter count', () => {
  const result = parseFfprobeOutput(
    {
      streams: [],
      chapters: [{ id: 0 }, { id: 1 }, { id: 2 }],
      format: {
        format_name: 'matroska,webm',
        duration: '5400.123000',
        size: '8000000000',
        bit_rate: '11851000',
        tags: { title: 'Movie' },
      },
    },
    '/m/a.mkv',
    7_999_999_999,
    PROBED_AT,
  );
  expect(result).toEqual({
    path: '/m/a.mkv',
    formatName: 'matroska,webm',
    durationSec: 5400.123,
    sizeBytes: 7_999_999_999,
    bitRate: 11_851_000,
    chapterCount: 3,
    streams: [],
    tags: { title: 'Movie' },
    probedAt: PROBED_AT,
  });
});

test('parseFfprobeOutput - missing format falls back to unknown and zero duration', () => {
  const result = parseFfprobeOutput({ streams: [] }, '/m/a.mkv', 10, PROBED_AT);
  expect(result.formatName).toBe('unknown');
  expect(result.durationSec).toBe(0);
  expect(result.bitRate).toBeNull();
  expect(result.chapterCount).toBe(0);
});

test('parseFfprobeOutput - zero size argument uses the format size', () => {
  const result = parseFfprobeOutput({ format: { size: '4096' } }, '/disc', 0, PROBED_AT);
  expect(result.sizeBytes).toBe(4096);
});

test.each([
  ['not an object', 'garbage'],
  ['streams not an array', { streams: 'x' }],
  ['stream without index', { streams: [{ codec_type: 'audio' }] }],
])('parseFfprobeOutput - rejects %s', (_label, raw) => {
  expect(() => parseFfprobeOutput(raw, '/m/a.mkv', 1, PROBED_AT)).toThrow(AppError);
});

test('parseFfprobeOutput - matroska audio: DURATION tag, BPS tag, normalised language, title, default', () => {
  const stream = parseStream({
    codec_type: 'audio',
    codec_name: 'DTS',
    codec_long_name: 'DCA (DTS Coherent Acoustics)',
    profile: 'DTS',
    sample_rate: '48000',
    channels: 6,
    channel_layout: '5.1(side)',
    bits_per_sample: 0,
    start_time: '0.000000',
    disposition: disposition({ default: 1 }),
    tags: { language: 'spa', title: 'Castellano DTS', BPS: '1509000', DURATION: '01:30:00.500000000' },
  }) as AudioStream;
  expect(stream).toEqual({
    index: 0,
    streamId: null,
    startTimeSec: 0,
    codec: 'dts',
    codecLongName: 'DCA (DTS Coherent Acoustics)',
    profile: 'DTS',
    language: 'spa',
    title: 'Castellano DTS',
    default: true,
    forced: false,
    bitRate: 1_509_000,
    durationSec: 5400.5,
    kind: 'audio',
    channels: 6,
    channelLayout: '5.1(side)',
    sampleRate: 48000,
    bitsPerSample: null,
    objectAudio: null,
    lossless: false,
  });
});

test.each([
  ['dts', 'DTS-HD MA', null, true],
  ['dts', 'DTS-HD MA + DTS:X', 'dtsx', true],
  ['dts', 'DTS-HD HRA', null, false],
  ['truehd', 'Dolby TrueHD + Dolby Atmos', 'atmos', true],
  ['eac3', 'Dolby Digital Plus + Dolby Atmos', 'atmos', false],
  ['eac3', 'JOC', 'atmos', false],
  ['flac', undefined, null, true],
  ['pcm_s24le', undefined, null, true],
  ['ac3', undefined, null, false],
  ['opus', undefined, null, false],
] as const)(
  'parseFfprobeOutput - audio %s profile %s -> objectAudio %s, lossless %s',
  (codec, profile, object, lossless) => {
    const stream = parseStream({ codec_type: 'audio', codec_name: codec, profile, channels: 8 }) as AudioStream;
    expect(stream.objectAudio).toBe(object);
    expect(stream.lossless).toBe(lossless);
  },
);

test('parseFfprobeOutput - m2ts stream id is parsed from hex and the start time kept', () => {
  const stream = parseStream({
    codec_type: 'audio',
    codec_name: 'truehd',
    id: '0x1100',
    start_time: '600.023000',
    tags: { language: 'deu' },
  });
  expect(stream.streamId).toBe(4352);
  expect(stream.startTimeSec).toBe(600.023);
  expect(stream.language).toBe('ger');
});

test.each([
  ['und', null],
  ['eng', 'eng'],
  ['fra', 'fre'],
  ['', null],
])('parseFfprobeOutput - language tag %p -> %p', (tag, expected) => {
  expect(parseStream({ codec_type: 'audio', codec_name: 'ac3', tags: { LANGUAGE: tag } }).language).toBe(expected);
});

test('parseFfprobeOutput - SDR h264 video', () => {
  const stream = parseStream({
    codec_type: 'video',
    codec_name: 'h264',
    profile: 'High',
    width: 1920,
    height: 1080,
    pix_fmt: 'yuv420p',
    r_frame_rate: '24000/1001',
    avg_frame_rate: '24000/1001',
    disposition: disposition({ default: 1 }),
  }) as VideoStream;
  expect(stream).toMatchObject({
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
  });
});

test.each([
  ['smpte2084', [], 'hdr10'],
  ['arib-std-b67', [], 'hlg'],
  ['smpte2084', [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }], 'hdr10plus'],
  ['bt709', [], 'sdr'],
] as const)('parseFfprobeOutput - transfer %s with side data %j -> %s', (transfer, sideData, hdr) => {
  const stream = parseStream({
    codec_type: 'video',
    codec_name: 'hevc',
    pix_fmt: 'yuv420p10le',
    color_transfer: transfer,
    side_data_list: sideData,
  }) as VideoStream;
  expect(stream.hdr).toBe(hdr);
  expect(stream.bitDepth).toBe(10);
});

test('parseFfprobeOutput - Dolby Vision configuration record', () => {
  const stream = parseStream({
    codec_type: 'video',
    codec_name: 'hevc',
    color_transfer: 'smpte2084',
    bits_per_raw_sample: '10',
    side_data_list: [
      {
        side_data_type: 'DOVI configuration record',
        dv_profile: 7,
        dv_level: 6,
        rpu_present_flag: 1,
        el_present_flag: 1,
        bl_present_flag: 1,
        dv_bl_signal_compatibility_id: 6,
      },
    ],
  }) as VideoStream;
  expect(stream.hdr).toBe('dolby_vision');
  expect(stream.dolbyVision).toEqual({
    profile: 7,
    level: 6,
    rpuPresent: true,
    elPresent: true,
    blPresent: true,
    blSignalCompatibilityId: 6,
  });
});

test.each([
  [{ codec_name: 'mjpeg', disposition: disposition({ attached_pic: 1 }) }, 'attachedPicture', true],
  [{ codec_name: 'h264', profile: 'Stereo High' }, 'stereo3d', true],
  [{ codec_name: 'h264', side_data_list: [{ side_data_type: 'Stereo 3D' }] }, 'stereo3d', true],
  [{ codec_name: 'h264', r_frame_rate: '0/0' }, 'frameRate', null],
] as const)('parseFfprobeOutput - video %j -> %s %p', (raw, field, expected) => {
  const stream = parseStream({ codec_type: 'video', ...raw }) as VideoStream;
  expect(stream[field]).toBe(expected);
});

test.each([
  ['hdmv_pgs_subtitle', true],
  ['dvd_subtitle', true],
  ['subrip', false],
  ['ass', false],
])('parseFfprobeOutput - subtitle %s bitmap %p', (codec, bitmap) => {
  const stream = parseStream({
    codec_type: 'subtitle',
    codec_name: codec,
    disposition: disposition({ forced: 1, hearing_impaired: 1 }),
  }) as SubtitleStream;
  expect(stream).toMatchObject({ kind: 'subtitle', bitmap, forced: true, hearingImpaired: true });
});

test('parseFfprobeOutput - attachment keeps file name and mime type', () => {
  const stream = parseStream({
    codec_type: 'attachment',
    codec_name: 'ttf',
    tags: { filename: 'font.ttf', mimetype: 'application/x-truetype-font' },
  }) as OtherStream;
  expect(stream).toMatchObject({
    kind: 'attachment',
    codec: 'ttf',
    filename: 'font.ttf',
    mimeType: 'application/x-truetype-font',
  });
});

test('parseFfprobeOutput - unknown codec type becomes data and a missing codec "unknown"', () => {
  const stream = parseStream({ codec_type: 'nonsense' }) as OtherStream;
  expect(stream.kind).toBe('data');
  expect(stream.codec).toBe('unknown');
  expect(stream.filename).toBeNull();
});
