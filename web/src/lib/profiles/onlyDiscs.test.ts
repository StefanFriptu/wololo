import { expect, test } from 'bun:test';
import { onlyDiscs } from './onlyDiscs.ts';

test('onlyDiscs - bdmv and iso alone are discs', () => {
  expect(onlyDiscs(['bdmv', 'iso'])).toBe(true);
});

test('onlyDiscs - a plain file makes the set mixed', () => {
  expect(onlyDiscs(['bdmv', 'file'])).toBe(false);
});

test('onlyDiscs - an empty set is not discs, so callers still ask', () => {
  expect(onlyDiscs([])).toBe(false);
});
