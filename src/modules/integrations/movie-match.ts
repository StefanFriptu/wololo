export interface TitleYear {
  title: string;
  year: number | null;
}

const TRAILING_YEAR = /^(.*?)\s*[([]((?:19|20)\d{2})[)\]]\s*$/;

/** "Jamon Jamon (1992)" -> { title: "Jamon Jamon", year: 1992 }; the given year wins over one parsed from the term. */
export function parseTitleYear(term: string, year: number | null = null): TitleYear {
  const match = TRAILING_YEAR.exec(term.trim());
  const title = match?.[1]?.trim();
  if (!match || !title) return { title: term.trim(), year };
  return { title, year: year ?? Number(match[2]) };
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  const compact = value.replace(/ /g, '');
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen-Dice coefficient over character bigrams of the normalised titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === right) return left === '' ? 0 : 1;
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  const total = [...leftGrams.values(), ...rightGrams.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  let shared = 0;
  for (const [gram, count] of leftGrams) shared += Math.min(count, rightGrams.get(gram) ?? 0);
  return (2 * shared) / total;
}

function yearFactor(wanted: number | null, candidate: number | null): number {
  if (wanted == null || candidate == null) return 0.9;
  const distance = Math.abs(wanted - candidate);
  if (distance === 0) return 1;
  if (distance === 1) return 0.9;
  return 0.6;
}

/**
 * 0..1: best title similarity (title or original title) times a year factor
 * (same year 1, off by one 0.9, unknown 0.9, otherwise 0.6), rounded to 3 decimals.
 */
export function movieMatchScore(
  wanted: TitleYear,
  candidate: { title: string; originalTitle?: string | null; year: number | null },
): number {
  const titles = [candidate.title, candidate.originalTitle].filter((title): title is string => !!title);
  const similarity = Math.max(0, ...titles.map((title) => titleSimilarity(wanted.title, title)));
  return Math.round(similarity * yearFactor(wanted.year, candidate.year) * 1000) / 1000;
}
