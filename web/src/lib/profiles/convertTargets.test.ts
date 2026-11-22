import { expect, test } from 'bun:test';
import { convertTargets, STRICTEST_TARGET } from './convertTargets.ts';

const profiles = [
  { id: 1, name: 'Living room' },
  { id: 2, name: 'Bedroom' },
];

test('convertTargets - no profile means no choice', () => {
  expect(convertTargets([], profiles)).toEqual([]);
});

test('convertTargets - a single profile means no choice', () => {
  expect(convertTargets([1], profiles)).toEqual([]);
});

test('convertTargets - offers the strictest first, then each assigned profile by name', () => {
  expect(convertTargets([2, 1], profiles)).toEqual([
    STRICTEST_TARGET,
    { profileId: 2, label: 'Bedroom' },
    { profileId: 1, label: 'Living room' },
  ]);
});

test('convertTargets - lists a profile shared by several libraries once', () => {
  expect(convertTargets([1, 2, 1], profiles).length).toBe(3);
});

test('convertTargets - falls back to the id for an unknown profile', () => {
  expect(convertTargets([1, 9], profiles).at(-1)).toEqual({ profileId: 9, label: '#9' });
});

test('convertTargets - the strictest option sends no profile id', () => {
  expect(STRICTEST_TARGET.profileId).toBeUndefined();
});
