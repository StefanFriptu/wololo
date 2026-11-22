import { expect, test } from 'bun:test';
import { nameById } from './nameById.ts';

const ITEMS = [
  { id: 1, name: 'Movies' },
  { id: 2, name: 'TV' },
];

test('nameById - returns the name of a known id', () => {
  expect(nameById(ITEMS, 2)).toBe('TV');
});

test('nameById - falls back to #id for an unknown id', () => {
  expect(nameById(ITEMS, 9)).toBe('#9');
});

test('nameById - falls back to #id while the list is not loaded', () => {
  expect(nameById(undefined, 1)).toBe('#1');
});
