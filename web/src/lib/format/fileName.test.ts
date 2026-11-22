import { expect, test } from 'bun:test';
import { fileName } from './fileName.ts';

test.each([
  ['/media/movies/Film (2020)/film.mkv', 'film.mkv'],
  ['film.mkv', 'film.mkv'],
  ['/media/movies/Film/', 'Film'],
  ['//a//b//', 'b'],
  ['/', '/'],
  ['', ''],
])('fileName - %p -> %p', (path, expected) => {
  expect(fileName(path)).toBe(expected);
});
