import type { MediaStream } from '#lib/shared.ts';
import { formatChannels } from './formatChannels.ts';

export interface StreamDescription {
  /** Codec as people know it: the ffprobe profile when present ("DTS-HD MA"), else the codec name upper-cased. */
  codec: string;
  /** Layout, resolution, bit rate and similar facts, joined for one table cell. */
  details: string;
  language: string;
  flags: string[];
}

const HDR_LABELS = {
  sdr: null,
  hdr10: 'HDR10',
  hdr10plus: 'HDR10+',
  hlg: 'HLG',
  dolby_vision: 'Dolby Vision',
} as const;

function detailsOf(stream: MediaStream): string[] {
  switch (stream.kind) {
    case 'video': {
      const hdr = HDR_LABELS[stream.hdr];
      const dv = stream.dolbyVision ? `DV profile ${stream.dolbyVision.profile}` : null;
      return [
        `${stream.width}x${stream.height}`,
        stream.frameRate ? `${Number(stream.frameRate.toFixed(3))} fps` : null,
        stream.bitDepth ? `${stream.bitDepth}-bit` : null,
        dv ?? hdr,
        stream.stereo3d ? '3D' : null,
      ].filter((part): part is string => part !== null);
    }
    case 'audio':
      return [
        formatChannels(stream.channels, stream.channelLayout),
        stream.sampleRate ? `${stream.sampleRate / 1000} kHz` : null,
        stream.objectAudio === 'atmos' ? 'Atmos' : stream.objectAudio === 'dtsx' ? 'DTS:X' : null,
        stream.bitRate ? `${Math.round(stream.bitRate / 1000)} kbps` : null,
      ].filter((part): part is string => part !== null);
    case 'subtitle':
      return [stream.bitmap ? 'image' : 'text', stream.hearingImpaired ? 'SDH' : null].filter(
        (part): part is string => part !== null,
      );
    default:
      return [stream.filename, stream.mimeType].filter((part): part is string => part !== null);
  }
}

export function describeStream(stream: MediaStream): StreamDescription {
  const flags = [stream.default ? 'default' : null, stream.forced ? 'forced' : null].filter(
    (flag): flag is string => flag !== null,
  );
  return {
    codec: stream.profile && stream.kind !== 'video' ? stream.profile : stream.codec.toUpperCase(),
    details: [...detailsOf(stream), stream.title ? `"${stream.title}"` : null].filter(Boolean).join(' · '),
    language: stream.language ?? 'und',
    flags,
  };
}
