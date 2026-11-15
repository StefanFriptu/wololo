import { expect, test } from 'bun:test';
import { formatBytes } from './formatBytes.ts';

test.each([
  [null, '-'],
  [undefined, '-'],
  [Number.NaN, '-'],
  [0, '0 B'],
  [1023, '1023 B'],
  [1024, '1.0 KiB'],
  [1536, '1.5 KiB'],
  [5 * 1024 ** 2, '5.0 MiB'],
  [1.25 * 1024 ** 3, '1.3 GiB'],
  [7 * 1024 ** 4, '7.0 TiB'],
  [3 * 1024 ** 6, '3072.0 PiB'],
  [-2048, '-2.0 KiB'],
])('formatBytes - %p renders %p', (input, expected) => {
  expect(formatBytes(input)).toBe(expected);
});
