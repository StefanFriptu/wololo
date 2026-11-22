import type { ProfileTemplate, ProfileTemplateId } from '../../shared/api-types.ts';
import type { DeviceProfileDefinition } from '../../shared/domain.ts';

const BASIC_AUDIO = ['ac3', 'aac', 'mp3'];
const DOLBY_AUDIO = [...BASIC_AUDIO, 'eac3', 'truehd'];
const LOSSLESS_AUDIO = [...DOLBY_AUDIO, 'flac', 'alac', 'pcm_*'];
const EVERY_AUDIO = [...LOSSLESS_AUDIO, 'dts', 'mp2', 'opus', 'vorbis'];

function definition(
  allowedCodecs: readonly string[],
  targetCodec: DeviceProfileDefinition['audio']['targetCodec'],
  maxChannels: number,
): DeviceProfileDefinition {
  return {
    audio: {
      allowedCodecs: [...allowedCodecs],
      targetCodec,
      bitrates: { mono: 192, stereo: 448, surround: 640 },
      maxChannels,
    },
    video: {
      allowedCodecs: ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'vc1', 'mpeg4'],
      dolbyVision: 'drop_hdr10',
    },
    subtitles: { allowedCodecs: ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'] },
    container: 'mkv',
  };
}

const TEMPLATES: Readonly<Record<ProfileTemplateId, () => Omit<ProfileTemplate, 'id'>>> = {
  basic: () => ({
    name: 'Basic',
    description: 'AC3, AAC and MP3. Everything else converts to AC3.',
    definition: definition(BASIC_AUDIO, 'ac3', 6),
  }),
  dolby: () => ({
    name: 'Dolby',
    description: 'Basic plus E-AC3 and TrueHD. Everything else converts to E-AC3.',
    definition: definition(DOLBY_AUDIO, 'eac3', 8),
  }),
  lossless: () => ({
    name: 'Lossless',
    description: 'Dolby plus FLAC, ALAC and PCM.',
    definition: definition(LOSSLESS_AUDIO, 'eac3', 8),
  }),
  everything: () => ({
    name: 'Everything',
    description: 'An AV receiver decodes all audio, DTS included.',
    definition: definition(EVERY_AUDIO, 'eac3', 8),
  }),
  blank: () => ({
    name: 'Blank',
    description: 'Only the AC3 conversion target. Tick the codecs yourself.',
    definition: definition(['ac3'], 'ac3', 6),
  }),
};

/** Fresh objects on every call, so a caller may edit the definition it gets. */
export function templateDefinition(id: ProfileTemplateId): DeviceProfileDefinition {
  return TEMPLATES[id]().definition;
}

export function profileTemplates(): ProfileTemplate[] {
  return (Object.keys(TEMPLATES) as ProfileTemplateId[]).map((id) => ({ id, ...TEMPLATES[id]() }));
}
