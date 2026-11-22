import type { TargetAudioCodec } from './domain.ts';

export const AC3_MAX_KBPS = 640;
export const MAX_AUDIO_KBPS = 1536;

const LOSSLESS_AUDIO: ReadonlySet<string> = new Set(['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'ape', 'tta']);

/** Is an audio codec (with its ffprobe profile, when known) lossless? DTS counts only as DTS-HD MA. */
export function isLosslessAudio(codec: string, profile: string | null): boolean {
  if (LOSSLESS_AUDIO.has(codec) || codec.startsWith('pcm_')) return true;
  return codec === 'dts' && (profile?.toUpperCase().includes('DTS-HD MA') ?? false);
}

export function maxBitrateKbps(target: TargetAudioCodec): number {
  return target === 'ac3' ? AC3_MAX_KBPS : MAX_AUDIO_KBPS;
}

/** Does a codec name match an allowed list entry? Case-insensitive; a trailing "*" is a prefix wildcard ("pcm_*"). */
export function codecAllowed(codec: string, allowed: readonly string[]): boolean {
  const name = codec.toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  });
}
