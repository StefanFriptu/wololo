import { expect, test } from 'bun:test';
import { MEDIA_FILE_STATUSES, type MediaFileStatus } from '#lib/shared.ts';
import { fileProcessAction } from './fileProcessAction.ts';

test.each([
  ['needs_work', false],
  ['failed', true],
  ['compatible', true],
] as const)('fileProcessAction - %p queues with force %p', (status, force) => {
  expect(fileProcessAction(status)?.force).toBe(force);
});

test('fileProcessAction - only needs_work goes through without force, since the backend skips other statuses', () => {
  const unforced = MEDIA_FILE_STATUSES.filter((status: MediaFileStatus) => fileProcessAction(status)?.force === false);
  expect(unforced).toEqual(['needs_work']);
});

test.each(['pending', 'processing', 'ignored'] as const)('fileProcessAction - %p offers no button', (status) => {
  expect(fileProcessAction(status)).toBeNull();
});
