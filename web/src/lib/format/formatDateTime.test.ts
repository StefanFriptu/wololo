import { expect, test } from 'bun:test';
import { formatDateTime } from './formatDateTime.ts';

test.each([null, undefined, '', 'garbage'])('formatDateTime - %p renders a dash', (input) => {
  expect(formatDateTime(input)).toBe('-');
});

test('formatDateTime - valid timestamp includes the year', () => {
  expect(formatDateTime('2026-11-15T12:00:00.000Z')).toContain('2026');
});
