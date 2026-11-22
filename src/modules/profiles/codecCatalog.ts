import type { CodecCatalog, CodecInfo } from '../../shared/api-types.ts';
import { isLosslessAudio } from '../../shared/audioRules.ts';

type Entry = readonly [codec: string, label: string];

const AUDIO: readonly Entry[] = [
  ['ac3', 'Dolby Digital (AC3)'],
  ['eac3', 'Dolby Digital Plus (E-AC3, incl. Atmos JOC)'],
  ['aac', 'AAC'],
  ['mp3', 'MP3'],
  ['mp2', 'MPEG Layer II'],
  ['dts', 'DTS, DTS-HD MA, DTS:X'],
  ['truehd', 'Dolby TrueHD (incl. Atmos)'],
  ['flac', 'FLAC'],
  ['alac', 'Apple Lossless (ALAC)'],
  ['pcm_*', 'LPCM (any sample format)'],
  ['opus', 'Opus'],
  ['vorbis', 'Vorbis'],
];

const VIDEO: readonly Entry[] = [
  ['h264', 'H.264 / AVC'],
  ['hevc', 'H.265 / HEVC'],
  ['av1', 'AV1'],
  ['vp9', 'VP9'],
  ['vp8', 'VP8'],
  ['mpeg2video', 'MPEG-2'],
  ['vc1', 'VC-1'],
  ['mpeg4', 'MPEG-4 Part 2 (DivX/Xvid)'],
];

const SUBTITLE: readonly Entry[] = [
  ['subrip', 'SubRip (SRT)'],
  ['ass', 'Advanced SubStation Alpha (ASS)'],
  ['ssa', 'SubStation Alpha (SSA)'],
  ['webvtt', 'WebVTT'],
  ['mov_text', 'MP4 timed text'],
  ['text', 'Plain text'],
  ['hdmv_pgs_subtitle', 'Blu-ray PGS (picture)'],
  ['dvd_subtitle', 'DVD VobSub (picture)'],
  ['dvb_subtitle', 'DVB (picture)'],
];

function toInfo(kind: CodecInfo['kind']) {
  return ([codec, label]: Entry): CodecInfo => ({
    codec,
    label,
    kind,
    lossless: kind === 'audio' && isLosslessAudio(codec, null),
  });
}

export function codecCatalog(): CodecCatalog {
  return {
    audio: AUDIO.map(toInfo('audio')),
    video: VIDEO.map(toInfo('video')),
    subtitle: SUBTITLE.map(toInfo('subtitle')),
  };
}
