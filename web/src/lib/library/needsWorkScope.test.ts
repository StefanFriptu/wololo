import { expect, test } from 'bun:test';
import { needsWorkScope } from './needsWorkScope.ts';

const base = { libraryName: null, profileName: null, listedTotal: null };

test('needsWorkScope - sends the search and codec filters and names them', () => {
  const scope = needsWorkScope({ ...base, filters: { search: 'Alien', codec: 'dts', kind: 'bdmv,iso' } });
  expect(scope.filter).toMatchObject({ search: 'Alien', codec: 'dts', kind: 'bdmv,iso' });
  expect(scope.question).toBe(
    'Queue every file that needs work in every library of type Blu-ray (folder or ISO) with a dts stream matching "Alien"?',
  );
});

test('needsWorkScope - no filters asks about every library', () => {
  expect(needsWorkScope({ ...base, filters: {} })).toEqual({
    filter: {
      status: 'needs_work',
      libraryId: undefined,
      failingCodec: undefined,
      kind: undefined,
      profileId: undefined,
      search: undefined,
      codec: undefined,
    },
    question: 'Queue every file that needs work in every library?',
  });
});

test('needsWorkScope - names every field it sends', () => {
  const scope = needsWorkScope({
    ...base,
    filters: { libraryId: 2, kind: 'iso', failingCodec: 'truehd', profileId: 4, status: 'failed' },
    libraryName: 'Movies',
    profileName: 'LG C1',
  });
  expect(scope).toEqual({
    filter: { status: 'needs_work', libraryId: 2, failingCodec: 'truehd', kind: 'iso', profileId: 4 },
    question:
      'Queue every file that needs work in Movies of type Blu-ray ISO failing on truehd checked against profile LG C1?',
  });
});

test('needsWorkScope - states the count when the list shows exactly the needs-work files', () => {
  const scope = needsWorkScope({ ...base, filters: { status: 'needs_work', libraryId: 3 }, listedTotal: 12 });
  expect(scope.question).toBe('Queue all 12 file(s) that need work in library #3?');
});

test('needsWorkScope - leaves the count out when the list shows another status', () => {
  const scope = needsWorkScope({ ...base, filters: { status: 'compatible' }, listedTotal: 12 });
  expect(scope.question).toBe('Queue every file that needs work in every library?');
});
