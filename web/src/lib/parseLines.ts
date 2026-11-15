/** One entry per non-empty line, trimmed and de-duplicated, case kept (glob patterns are case-sensitive). */
export function parseLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}
