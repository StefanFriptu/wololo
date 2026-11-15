/** "eng, ger; SPA" -> ["eng", "ger", "spa"]: split on commas, semicolons and whitespace, lower-case, de-duplicate. */
export function parseList(text: string): string[] {
  const items = text
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}
