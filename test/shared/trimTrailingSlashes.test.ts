import { expect, test } from 'bun:test';
import { trimTrailingSlashes } from '../../src/shared/trimTrailingSlashes.ts';

test.each([
  ['http://host:7878', 'http://host:7878'],
  ['http://host:7878/', 'http://host:7878'],
  ['http://host/base///', 'http://host/base'],
  ['http://host/a/b', 'http://host/a/b'],
  ['/', ''],
  ['', ''],
  [' http://host/ ', ' http://host/ '],
])('trimTrailingSlashes - %j -> %j', (input, expected) => {
  expect(trimTrailingSlashes(input)).toBe(expected);
});
