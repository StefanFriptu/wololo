import { expect, test } from 'bun:test';
import { movieMatchScore, normalizeTitle, parseTitleYear, titleSimilarity } from './movie-match.ts';

test.each([
  ['parseTitleYear - year in parentheses', 'Jamon Jamon (1992)', null, { title: 'Jamon Jamon', year: 1992 }],
  ['parseTitleYear - year in brackets', 'Heat [1995]', null, { title: 'Heat', year: 1995 }],
  ['parseTitleYear - explicit year wins', 'Heat (1995)', 1996, { title: 'Heat', year: 1996 }],
  [
    'parseTitleYear - bare trailing number stays in the title',
    'Blade Runner 2049',
    null,
    { title: 'Blade Runner 2049', year: null },
  ],
  ['parseTitleYear - no year', 'Alien', null, { title: 'Alien', year: null }],
  ['parseTitleYear - a title that is only a year', '(1992)', null, { title: '(1992)', year: null }],
] as const)('%s', (_name, term, year, expected) => {
  expect(parseTitleYear(term, year)).toEqual(expected);
});

test.each([
  ['normalizeTitle - strips diacritics and punctuation', 'Jamón, Jamón!', 'jamon jamon'],
  ['normalizeTitle - ampersand becomes and', 'Fast & Furious', 'fast and furious'],
  ['normalizeTitle - drops a leading article', 'The Matrix', 'matrix'],
  ['normalizeTitle - drops apostrophes inside words', "Schindler's List", 'schindlers list'],
])('%s', (_name, input, expected) => {
  expect(normalizeTitle(input)).toBe(expected);
});

test('titleSimilarity - identical after normalisation is 1', () => {
  expect(titleSimilarity('Jamon Jamon', 'Jamón Jamón')).toBe(1);
});

test('titleSimilarity - unrelated titles score low', () => {
  expect(titleSimilarity('Jamon Jamon', 'Toy Story')).toBeLessThan(0.3);
});

test('titleSimilarity - empty titles score 0', () => {
  expect(titleSimilarity('', '')).toBe(0);
});

test.each([
  ['movieMatchScore - exact title and year', { title: 'Heat', year: 1995 }, { title: 'Heat', year: 1995 }, 1],
  ['movieMatchScore - year off by one', { title: 'Heat', year: 1995 }, { title: 'Heat', year: 1996 }, 0.9],
  ['movieMatchScore - remake with another year', { title: 'Heat', year: 1995 }, { title: 'Heat', year: 1986 }, 0.6],
  ['movieMatchScore - unknown wanted year', { title: 'Heat', year: null }, { title: 'Heat', year: 1995 }, 0.9],
  ['movieMatchScore - unknown candidate year', { title: 'Heat', year: 1995 }, { title: 'Heat', year: null }, 0.9],
] as const)('%s', (_name, wanted, candidate, expected) => {
  expect(movieMatchScore(wanted, candidate)).toBe(expected);
});

test('movieMatchScore - original title counts when it matches better', () => {
  const score = movieMatchScore(
    { title: 'Jamon Jamon', year: 1992 },
    { title: 'Jamón, Jamón', originalTitle: 'Jamón, jamón', year: 1992 },
  );
  expect(score).toBe(1);
});

test('movieMatchScore - a different movie stays below the default threshold', () => {
  expect(movieMatchScore({ title: 'Jamon Jamon', year: 1992 }, { title: 'Golden Balls', year: 1993 })).toBeLessThan(
    0.8,
  );
});
