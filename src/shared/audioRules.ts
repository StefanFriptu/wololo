import type { TargetAudioCodec } from './domain.ts';

export const AC3_MAX_KBPS = 640;
export const MAX_AUDIO_KBPS = 1536;

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
