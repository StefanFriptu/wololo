import { expect, test } from 'bun:test';
import { dryRunGroupQuery } from './dryRunGroupQuery.ts';

test.each([
  ['dts', undefined, '?status=needs_work&failingCodec=dts'],
  ['truehd', 4, '?status=needs_work&failingCodec=truehd&libraryId=4'],
  ['video:vc1', undefined, '?status=blocked&codec=vc1'],
  ['blocked', undefined, '?status=blocked'],
  ['bdmv', 2, '?status=needs_work&kind=bdmv%2Ciso&libraryId=2'],
] as const)('dryRunGroupQuery - group %p in library %p links to %p', (codec, libraryId, expected) => {
  expect(dryRunGroupQuery(codec, libraryId)).toBe(expected);
});
