import { AppError } from '../../core/errors.ts';

/** "00800.mpls" or "800" -> 800. */
export function playlistNumber(playlist: string): number {
  const match = playlist.trim().match(/^(\d+)(?:\.mpls)?$/i);
  if (!match) throw new AppError('validation', `invalid playlist name: ${playlist}`);
  return Number(match[1]);
}

/** Pure: ffprobe argv without the binary. A playlist probes `bluray:<disc>` through libbluray. */
export function buildProbeArgs(path: string, options: { withChapters?: boolean; playlist?: string } = {}): string[] {
  const args = ['-v', 'error', '-show_streams', '-show_format'];
  if (options.withChapters ?? true) args.push('-show_chapters');
  args.push('-of', 'json');
  if (options.playlist === undefined) return [...args, '-i', path];
  return [...args, '-playlist', String(playlistNumber(options.playlist)), '-i', `bluray:${path}`];
}
