import { expect, test } from 'bun:test';
import { DAY_MS, MINUTE_MS } from '../../src/core/time.ts';

test('time - constants are whole minutes and days in milliseconds', () => {
  expect(MINUTE_MS).toBe(60 * 1000);
  expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
});
