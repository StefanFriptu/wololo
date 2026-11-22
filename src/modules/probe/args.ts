import { blurayInput, playlistArgs } from '../../core/bluray.ts';

/** Pure: ffprobe argv without the binary. A playlist probes `bluray:<disc>` through libbluray. */
export function buildProbeArgs(path: string, options: { withChapters?: boolean; playlist?: string } = {}): string[] {
  const args = ['-v', 'error', '-show_streams', '-show_format'];
  if (options.withChapters ?? true) args.push('-show_chapters');
  args.push('-of', 'json');
  if (options.playlist === undefined) return [...args, '-i', path];
  return [...args, ...playlistArgs(options.playlist), '-i', blurayInput(path)];
}
