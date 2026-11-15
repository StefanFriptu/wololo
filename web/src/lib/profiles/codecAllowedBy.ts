/** Is the codec in the allowed list? A trailing "*" is a prefix wildcard ("pcm_*" allows "pcm_s24le"). */
export function codecAllowedBy(allowed: readonly string[], codec: string): boolean {
  return allowed.some((entry) => (entry.endsWith('*') ? codec.startsWith(entry.slice(0, -1)) : entry === codec));
}
