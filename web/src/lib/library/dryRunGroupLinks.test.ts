import { expect, test } from 'bun:test';
import { dryRunGroupLinks } from './dryRunGroupLinks.ts';

test.each([
  ['dts', undefined, [{ label: 'dts', query: '?status=needs_work&failingCodec=dts' }]],
  ['truehd', 4, [{ label: 'truehd', query: '?status=needs_work&failingCodec=truehd&libraryId=4' }]],
  ['video:vc1', undefined, [{ label: 'video:vc1', query: '?status=needs_work&codec=vc1' }]],
  [
    'bdmv',
    2,
    [
      { label: 'folders', query: '?status=needs_work&kind=bdmv&libraryId=2' },
      { label: 'ISOs', query: '?status=needs_work&kind=iso&libraryId=2' },
    ],
  ],
] as const)('dryRunGroupLinks - group %p in library %p links to %p', (codec, libraryId, expected) => {
  expect(dryRunGroupLinks(codec, libraryId)).toEqual([...expected]);
});

test('dryRunGroupLinks - disc work covers both BDMV folders and ISOs', () => {
  const kinds = dryRunGroupLinks('bdmv', undefined).map((link) => new URLSearchParams(link.query).get('kind'));
  expect(kinds).toEqual(['bdmv', 'iso']);
});
