import { expect, test } from 'bun:test';
import { withTimeout } from '../../src/core/withTimeout.ts';

test('withTimeout - resolves with the work when it finishes in time', async () => {
  expect(await withTimeout(Promise.resolve('done'), 50, 'late')).toBe('done');
});

test('withTimeout - resolves with the fallback when the work is slower than the budget', async () => {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 200));
  expect(await withTimeout(slow, 10, 'late')).toBe('late');
});

test('withTimeout - rejects when the work rejects before the budget', async () => {
  await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'late')).rejects.toThrow('boom');
});
