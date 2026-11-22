import { afterEach, expect, test } from 'bun:test';
import { compileRunes } from '#lib/testing/compileRunes.ts';

compileRunes();
const { toasts } = await import('#lib/toast.svelte.ts');
const { attemptOk } = await import('./attempt.ts');

afterEach(() => {
  for (const item of [...toasts.items]) toasts.dismiss(item.id);
});

test('attemptOk - resolves true and shows the success toast', async () => {
  expect(await attemptOk(async () => undefined, 'Done')).toBe(true);
  expect(toasts.items.map((item) => [item.tone, item.message])).toEqual([['success', 'Done']]);
});

test('attemptOk - resolves true without a toast when no message is given', async () => {
  expect(await attemptOk(async () => undefined)).toBe(true);
  expect(toasts.items).toEqual([]);
});

test('attemptOk - resolves false and shows the error toast on failure', async () => {
  const ok = await attemptOk(async () => {
    throw new Error('nope');
  }, 'Done');
  expect(ok).toBe(false);
  expect(toasts.items.map((item) => [item.tone, item.message])).toEqual([['danger', 'nope']]);
});
