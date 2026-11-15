import { expect, test } from 'bun:test';
import { formatSpeed } from './formatSpeed.ts';

test.each([
  [null, '-'],
  [Number.NaN, '-'],
  [-1, '-'],
  [0, '0.0x'],
  [7.7, '7.7x'],
  [12.345, '12.3x'],
])('formatSpeed - %p renders %p', (input, expected) => {
  expect(formatSpeed(input)).toBe(expected);
});
