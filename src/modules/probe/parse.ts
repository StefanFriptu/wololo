import { z } from 'zod';
import type { ParseFfprobeOutput } from '../../contracts/probe-scan.ts';
import { AppError } from '../../core/errors.ts';
import { isLosslessAudio } from '../../shared/audioRules.ts';
import type {
  AudioStream,
  DolbyVisionInfo,
  HdrFormat,
  MediaStream,
  OtherStream,
  StreamKind,
  SubtitleStream,
  VideoStream,
} from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';

const numeric = z.union([z.number(), z.string()]).optional();

const SideDataSchema = z.looseObject({
  side_data_type: z.string().optional(),
  dv_profile: numeric,
  dv_level: numeric,
  rpu_present_flag: numeric,
  el_present_flag: numeric,
  bl_present_flag: numeric,
  dv_bl_signal_compatibility_id: numeric,
});

const RawStreamSchema = z.looseObject({
  index: z.number().int(),
  id: z.string().optional(),
  codec_name: z.string().optional(),
  codec_long_name: z.string().optional(),
  profile: z.string().optional(),
  codec_type: z.string().optional(),
  width: numeric,
  height: numeric,
  pix_fmt: z.string().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  color_transfer: z.string().optional(),
  color_primaries: z.string().optional(),
  bits_per_raw_sample: numeric,
  bits_per_sample: numeric,
  sample_rate: numeric,
  channels: numeric,
  channel_layout: z.string().optional(),
  start_time: numeric,
  duration: numeric,
  bit_rate: numeric,
  disposition: z.record(z.string(), z.number()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(SideDataSchema).optional(),
});

const RawProbeSchema = z.looseObject({
  streams: z.array(RawStreamSchema).default([]),
  chapters: z.array(z.unknown()).optional(),
  format: z
    .looseObject({
      format_name: z.string().optional(),
      duration: numeric,
      size: numeric,
      bit_rate: numeric,
      tags: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

type RawStream = z.infer<typeof RawStreamSchema>;
type SideData = z.infer<typeof SideDataSchema>;

const STREAM_KINDS: Readonly<Record<string, StreamKind>> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
  data: 'data',
};

const BITMAP_SUBTITLES: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function toNumber(value: number | string | undefined): number | null {
  if (value == null || value === '' || value === 'N/A') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: number | string | undefined): number | null {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseStreamId(id: string | undefined): number | null {
  if (!id) return null;
  const parsed = /^0x[0-9a-f]+$/i.test(id) ? Number.parseInt(id, 16) : Number(id);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Matroska keeps per-track duration as a "DURATION" tag ("00:01:02.123000000"). */
function parseClockDuration(value: string | undefined): number | null {
  const match = value?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function tagValue(tags: Record<string, string> | undefined, name: string): string | undefined {
  if (!tags) return undefined;
  const lower = name.toLowerCase();
  const key = Object.keys(tags).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : tags[key];
}

function parseFrameRate(value: string | undefined): number | null {
  const match = value?.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const denominator = Number(match[2]);
  if (denominator === 0) return null;
  const rate = Number(match[1]) / denominator;
  return rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

function bitDepthFromPixelFormat(pixelFormat: string | undefined): number | null {
  if (!pixelFormat) return null;
  const match = pixelFormat.match(/p(\d{2})(?:le|be)$/);
  if (match) return Number(match[1]);
  return /^(yuv|yuvj|nv|gray)/.test(pixelFormat) ? 8 : null;
}

function dolbyVisionInfo(sideData: readonly SideData[]): DolbyVisionInfo | null {
  const record = sideData.find((entry) => entry.side_data_type?.toLowerCase().includes('dovi'));
  if (!record) return null;
  return {
    profile: toNumber(record.dv_profile) ?? 0,
    level: toNumber(record.dv_level) ?? 0,
    rpuPresent: toNumber(record.rpu_present_flag) === 1,
    elPresent: toNumber(record.el_present_flag) === 1,
    blPresent: toNumber(record.bl_present_flag) === 1,
    blSignalCompatibilityId: toNumber(record.dv_bl_signal_compatibility_id) ?? 0,
  };
}

function hdrFormat(raw: RawStream, dolbyVision: DolbyVisionInfo | null): HdrFormat {
  if (dolbyVision) return 'dolby_vision';
  const sideTypes = (raw.side_data_list ?? []).map((entry) => entry.side_data_type?.toLowerCase() ?? '');
  if (sideTypes.some((type) => type.includes('2094-40') || type.includes('hdr10+'))) return 'hdr10plus';
  if (raw.color_transfer === 'smpte2084') return 'hdr10';
  if (raw.color_transfer === 'arib-std-b67') return 'hlg';
  return 'sdr';
}

function isStereo3d(raw: RawStream, codec: string): boolean {
  if (codec === 'mvc' || codec === 'h264_mvc') return true;
  if (raw.profile?.toLowerCase().includes('stereo')) return true;
  return (raw.side_data_list ?? []).some((entry) => entry.side_data_type?.toLowerCase().includes('stereo 3d'));
}

function objectAudio(profile: string | null): AudioStream['objectAudio'] {
  const lower = profile?.toLowerCase() ?? '';
  if (lower.includes('atmos') || lower.includes('joc')) return 'atmos';
  if (lower.includes('dts:x') || lower.includes('dts-x')) return 'dtsx';
  return null;
}

function baseFields(raw: RawStream) {
  const tags = raw.tags;
  const disposition = raw.disposition ?? {};
  const profile = raw.profile ?? null;
  return {
    index: raw.index,
    streamId: parseStreamId(raw.id),
    startTimeSec: toNumber(raw.start_time),
    codec: raw.codec_name?.toLowerCase() ?? 'unknown',
    codecLongName: raw.codec_long_name ?? null,
    profile: profile === 'unknown' ? null : profile,
    language: normalizeLanguage(tagValue(tags, 'language')),
    title: tagValue(tags, 'title') ?? null,
    default: disposition.default === 1,
    forced: disposition.forced === 1,
    bitRate: positive(raw.bit_rate) ?? positive(tagValue(tags, 'BPS')),
    durationSec: positive(raw.duration) ?? parseClockDuration(tagValue(tags, 'DURATION')),
  };
}

function videoStream(raw: RawStream): VideoStream {
  const base = baseFields(raw);
  const dolbyVision = dolbyVisionInfo(raw.side_data_list ?? []);
  return {
    ...base,
    kind: 'video',
    width: toNumber(raw.width) ?? 0,
    height: toNumber(raw.height) ?? 0,
    frameRate: parseFrameRate(raw.avg_frame_rate) ?? parseFrameRate(raw.r_frame_rate),
    pixelFormat: raw.pix_fmt ?? null,
    bitDepth: positive(raw.bits_per_raw_sample) ?? bitDepthFromPixelFormat(raw.pix_fmt),
    hdr: hdrFormat(raw, dolbyVision),
    dolbyVision,
    attachedPicture: raw.disposition?.attached_pic === 1,
    stereo3d: isStereo3d(raw, base.codec),
  };
}

function audioStream(raw: RawStream): AudioStream {
  const base = baseFields(raw);
  return {
    ...base,
    kind: 'audio',
    channels: toNumber(raw.channels) ?? 0,
    channelLayout: raw.channel_layout ?? null,
    sampleRate: toNumber(raw.sample_rate) ?? 0,
    bitsPerSample: positive(raw.bits_per_raw_sample) ?? positive(raw.bits_per_sample),
    objectAudio: objectAudio(base.profile),
    lossless: isLosslessAudio(base.codec, base.profile),
  };
}

function subtitleStream(raw: RawStream): SubtitleStream {
  const base = baseFields(raw);
  return {
    ...base,
    kind: 'subtitle',
    bitmap: BITMAP_SUBTITLES.has(base.codec),
    hearingImpaired: raw.disposition?.hearing_impaired === 1,
  };
}

function otherStream(raw: RawStream, kind: OtherStream['kind']): OtherStream {
  return {
    ...baseFields(raw),
    kind,
    filename: tagValue(raw.tags, 'filename') ?? null,
    mimeType: tagValue(raw.tags, 'mimetype') ?? null,
  };
}

function mapStream(raw: RawStream): MediaStream {
  const kind = STREAM_KINDS[raw.codec_type ?? ''] ?? 'data';
  switch (kind) {
    case 'video':
      return videoStream(raw);
    case 'audio':
      return audioStream(raw);
    case 'subtitle':
      return subtitleStream(raw);
    case 'attachment':
    case 'data':
      return otherStream(raw, kind);
    default: {
      const unreachable: never = kind;
      throw new Error(`unknown stream kind ${unreachable}`);
    }
  }
}

export const parseFfprobeOutput: ParseFfprobeOutput = (raw, path, sizeBytes, probedAt) => {
  const parsed = RawProbeSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError('upstream', `unexpected ffprobe output for ${path}`, z.treeifyError(parsed.error));
  const { streams, chapters, format } = parsed.data;
  return {
    path,
    formatName: format?.format_name ?? 'unknown',
    durationSec: positive(format?.duration) ?? 0,
    sizeBytes: sizeBytes > 0 ? sizeBytes : (positive(format?.size) ?? 0),
    bitRate: positive(format?.bit_rate),
    chapterCount: chapters?.length ?? 0,
    streams: streams.map(mapStream),
    tags: format?.tags ?? {},
    probedAt,
  };
};
