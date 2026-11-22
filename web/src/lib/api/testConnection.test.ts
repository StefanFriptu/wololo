import { expect, test } from 'bun:test';
import { testConnection } from './testConnection.ts';

test('testConnection - passes a result through', async () => {
  const result = { ok: true, message: 'Connected', version: '5.0' };
  expect(await testConnection(async () => result)).toEqual(result);
});

test('testConnection - turns a thrown error into a failed result', async () => {
  const result = await testConnection(async () => {
    throw new Error('boom');
  });
  expect(result).toEqual({ ok: false, message: 'boom', version: null });
});
