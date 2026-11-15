import type { VerificationCheck } from '#lib/shared.ts';

export const VERIFICATION_LABELS: Readonly<Record<VerificationCheck['name'], string>> = {
  duration: 'Duration',
  stream_count: 'Stream count',
  video_checksum: 'Video checksum',
  video_packets: 'Video packets',
  audio_decode: 'Audio decode',
  chapters: 'Chapters',
  languages: 'Languages',
  free_space: 'Free space',
  output_exists: 'Output exists',
};
