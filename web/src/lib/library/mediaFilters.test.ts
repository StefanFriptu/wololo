import { expect, test } from 'bun:test';
import { DEFAULT_MEDIA_FILTERS } from './defaultMediaFilters.ts';
import { parseMediaFilters } from './parseMediaFilters.ts';
import { serializeMediaFilters } from './serializeMediaFilters.ts';

const parse = (query: string) => parseMediaFilters(new URLSearchParams(query));

test('parseMediaFilters - empty query yields the defaults only', () => {
  expect(parse('')).toEqual({ ...DEFAULT_MEDIA_FILTERS });
});

test('parseMediaFilters - valid values are kept and codecs lower-cased', () => {
  expect(
    parse('status=needs_work&kind=bdmv&libraryId=2&profileId=3&codec=DTS&failingCodec=TrueHD&search=%20matrix%20'),
  ).toEqual({
    ...DEFAULT_MEDIA_FILTERS,
    status: 'needs_work',
    kind: 'bdmv',
    libraryId: 2,
    profileId: 3,
    codec: 'dts',
    failingCodec: 'truehd',
    search: 'matrix',
  });
});

test.each([
  ['page=0', 'page', 1],
  ['page=-3', 'page', 1],
  ['page=2.5', 'page', 1],
  ['page=abc', 'page', 1],
  ['page=7', 'page', 7],
  ['pageSize=33', 'pageSize', 50],
  ['pageSize=100', 'pageSize', 100],
  ['sortKey=bogus', 'sortKey', 'path'],
  ['sortKey=size', 'sortKey', 'size'],
  ['sortDir=up', 'sortDir', 'asc'],
  ['sortDir=desc', 'sortDir', 'desc'],
] as const)('parseMediaFilters - %s gives %s %p', (query, key, expected) => {
  expect(parse(query)[key]).toBe(expected);
});

test.each([
  ['status=done', 'status'],
  ['kind=dvd', 'kind'],
  ['libraryId=x', 'libraryId'],
  ['search=%20%20', 'search'],
] as const)('parseMediaFilters - invalid %s drops %s', (query, key) => {
  expect(key in parse(query)).toBe(false);
});

test('serializeMediaFilters - defaults serialise to an empty string', () => {
  expect(serializeMediaFilters(DEFAULT_MEDIA_FILTERS)).toBe('');
});

test('serializeMediaFilters - non-default values are written in a stable order', () => {
  expect(
    serializeMediaFilters({ ...DEFAULT_MEDIA_FILTERS, page: 3, status: 'failed', libraryId: 1, search: 'a b' }),
  ).toBe('?libraryId=1&status=failed&search=a+b&page=3');
});

test('serializeMediaFilters - round trips through parseMediaFilters', () => {
  const filters = parse('libraryId=4&status=ignored&sortKey=size&sortDir=desc&pageSize=250&page=2&codec=eac3');
  expect(parse(serializeMediaFilters(filters).slice(1))).toEqual(filters);
});
