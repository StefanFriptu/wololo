import { expect, test } from 'bun:test';
import { parseLines } from './parseLines.ts';
import { parseList } from './parseList.ts';

test.each([
  ['', []],
  ['   ', []],
  ['eng', ['eng']],
  ['eng, ger;SPA', ['eng', 'ger', 'spa']],
  ['eng\nger  eng', ['eng', 'ger']],
  [',,eng,,', ['eng']],
])('parseList - %p gives %p', (input, expected) => {
  expect(parseList(input)).toEqual(expected);
});

test.each([
  ['', []],
  ['**/Sample/**', ['**/Sample/**']],
  ['  **/Sample/**  \r\n\n**/*.{a,b}\n**/Sample/**', ['**/Sample/**', '**/*.{a,b}']],
])('parseLines - %p gives %p', (input, expected) => {
  expect(parseLines(input)).toEqual(expected);
});
