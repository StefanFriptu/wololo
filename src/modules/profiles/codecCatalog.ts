import type { CodecCatalog, CodecInfo } from '../../shared/api-types.ts';

type Entry = readonly [codec: string, label: string, lossless: boolean];

const AUDIO: readonly Entry[] = [
  ['ac3', 'Dolby Digital (AC3)', false],
  ['eac3', 'Dolby Digital Plus (E-AC3, incl. Atmos JOC)', false],
  ['aac', 'AAC', false],
  ['mp3', 'MP3', false],
  ['mp2', 'MPEG Layer II', false],
  ['dts', 'DTS, DTS-HD MA, DTS:X', false],
  ['truehd', 'Dolby TrueHD (incl. Atmos)', true],
  ['flac', 'FLAC', true],
  ['alac', 'Apple Lossless (ALAC)', true],
  ['pcm_*', 'LPCM (any sample format)', true],
  ['opus', 'Opus', false],
  ['vorbis', 'Vorbis', false],
];

const VIDEO: readonly Entry[] = [
  ['h264', 'H.264 / AVC', false],
  ['hevc', 'H.265 / HEVC', false],
  ['av1', 'AV1', false],
  ['vp9', 'VP9', false],
  ['vp8', 'VP8', false],
  ['mpeg2video', 'MPEG-2', false],
  ['vc1', 'VC-1', false],
  ['mpeg4', 'MPEG-4 Part 2 (DivX/Xvid)', false],
];

const SUBTITLE: readonly Entry[] = [
  ['subrip', 'SubRip (SRT)', false],
  ['ass', 'Advanced SubStation Alpha (ASS)', false],
  ['ssa', 'SubStation Alpha (SSA)', false],
  ['webvtt', 'WebVTT', false],
  ['mov_text', 'MP4 timed text', false],
  ['text', 'Plain text', false],
  ['hdmv_pgs_subtitle', 'Blu-ray PGS (picture)', false],
  ['dvd_subtitle', 'DVD VobSub (picture)', false],
  ['dvb_subtitle', 'DVB (picture)', false],
];

function toInfo(kind: CodecInfo['kind']) {
  return ([codec, label, lossless]: Entry): CodecInfo => ({ codec, label, kind, lossless });
}

export function codecCatalog(): CodecCatalog {
  return {
    audio: AUDIO.map(toInfo('audio')),
    video: VIDEO.map(toInfo('video')),
    subtitle: SUBTITLE.map(toInfo('subtitle')),
  };
}
