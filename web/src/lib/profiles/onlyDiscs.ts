const DISC_KINDS: ReadonlySet<string> = new Set(['bdmv', 'iso']);

export function onlyDiscs(kinds: readonly string[]): boolean {
  return kinds.length > 0 && kinds.every((kind) => DISC_KINDS.has(kind));
}
