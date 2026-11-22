import { expect, test } from 'bun:test';
import { parseOptionalNumber } from './parseOptionalNumber.ts';

test.each([
  ['', undefined],
  ['0', 0],
  ['7', 7],
  ['12', 12],
])('parseOptionalNumber - %p -> %p', (value, expected) => {
  expect(parseOptionalNumber(value)).toBe(expected);
});
