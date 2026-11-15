import { expect, test } from 'bun:test';
import { formatRelativeTime } from './formatRelativeTime.ts';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const at = (offsetSec: number): string => new Date(NOW + offsetSec * 1000).toISOString();

test.each([
  [null, '-'],
  ['not a date', '-'],
  [at(0), 'just now'],
  [at(-30), 'just now'],
  [at(-150), '2 minutes ago'],
  [at(-3600), '1 hour ago'],
  [at(2 * 3600), 'in 2 hours'],
  [at(-86400), 'yesterday'],
  [at(-5 * 86400), '5 days ago'],
  [at(-45 * 86400), 'last month'],
  [at(-800 * 86400), '2 years ago'],
])('formatRelativeTime - %p renders %p', (input, expected) => {
  expect(formatRelativeTime(input, NOW)).toBe(expected);
});
