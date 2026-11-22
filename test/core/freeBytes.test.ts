import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { freeBytes, freeBytesSync } from '../../src/core/freeBytes.ts';

test('freeBytes - a positive number for an existing directory', async () => {
  expect(await freeBytes(tmpdir())).toBeGreaterThan(0);
});

test('freeBytes - rejects for a missing path', async () => {
  await expect(freeBytes('/definitely/not/here/wololo')).rejects.toThrow();
});

test('freeBytesSync - a positive number for an existing directory', () => {
  expect(freeBytesSync(tmpdir())).toBeGreaterThan(0);
});

test('freeBytesSync - throws for a missing path', () => {
  expect(() => freeBytesSync('/definitely/not/here/wololo')).toThrow();
});
