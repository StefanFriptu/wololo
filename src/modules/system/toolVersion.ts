import type { ToolInfo } from '../../shared/api-types.ts';

const VERSION_PATTERNS: Readonly<Record<ToolInfo['name'], RegExp>> = {
  ffmpeg: /^ffmpeg version (\S+)/m,
  ffprobe: /^ffprobe version (\S+)/m,
  mkvmerge: /^mkvmerge v(\d+(?:\.\d+)*)/m,
  '7z': /^7-Zip(?:\s+\[\d+\])?(?:\s+\([a-z]\))?\s+(\d+(?:\.\d+)+)/m,
  nice: /^nice \(GNU coreutils\) (\d+(?:\.\d+)+)/m,
  ionice: /^ionice from util-linux (\d+(?:\.\d+)+)/m,
};

/** Version string from a tool's version output, null when the output does not look like that tool. */
export function parseToolVersion(name: ToolInfo['name'], output: string): string | null {
  return VERSION_PATTERNS[name].exec(output.trim())?.[1] ?? null;
}

/** Whether `ffmpeg -protocols` output lists the protocol (e.g. "bluray", needs libbluray). */
export function hasFfmpegProtocol(output: string, protocol: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === protocol);
}
