import { AppError } from './errors.ts';

/** "00800.mpls" or "800" -> 800, the number ffmpeg's bluray protocol takes as -playlist. */
export function playlistNumber(playlist: string): number {
  const match = playlist.trim().match(/^(\d+)(?:\.mpls)?$/i);
  if (!match) throw new AppError('validation', `invalid playlist name: ${playlist}`);
  return Number(match[1]);
}

/** The libbluray protocol URL ffmpeg and ffprobe read a disc through. */
export function blurayInput(discPath: string): string {
  return `bluray:${discPath}`;
}

/** Input option selecting one playlist of a disc. */
export function playlistArgs(playlist: string): string[] {
  return ['-playlist', String(playlistNumber(playlist))];
}
