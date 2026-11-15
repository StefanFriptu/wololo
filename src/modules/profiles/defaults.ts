import type { DefaultProfileDefinition } from '../../contracts/rules-ffmpeg.ts';

export const samsungTizenDefinition: DefaultProfileDefinition = () => ({
  audio: {
    allowedCodecs: ['ac3', 'aac', 'mp3'],
    targetCodec: 'ac3',
    bitrates: { mono: 192, stereo: 448, surround: 640 },
    maxChannels: 6,
  },
  video: {
    allowedCodecs: ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'vc1', 'mpeg4'],
    dolbyVision: 'drop_hdr10',
    reencode: {
      enabled: false,
      fromCodecs: ['vc1', 'mpeg2video'],
      targetCodec: 'h264',
      crf: 18,
      preset: 'veryfast',
    },
  },
  subtitles: {
    allowedCodecs: ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'],
  },
  container: 'mkv',
});
