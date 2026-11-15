export function codecAllowedBy(allowed: readonly string[], codec: string): boolean {
  return allowed.some((entry) => (entry.endsWith('*') ? codec.startsWith(entry.slice(0, -1)) : entry === codec));
}
