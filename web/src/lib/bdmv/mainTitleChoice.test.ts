import { expect, test } from 'bun:test';
import { mainTitleChoice } from './mainTitleChoice.ts';

test('mainTitleChoice - nothing chosen is rejected', () => {
  expect(mainTitleChoice({ playlists: [], asEditions: false, editionNames: {} })).toEqual({
    ok: false,
    reason: 'Choose a playlist.',
  });
});

test('mainTitleChoice - one playlist without editions', () => {
  expect(
    mainTitleChoice({ playlists: ['00800.mpls'], asEditions: false, editionNames: { '00800.mpls': 'x' } }),
  ).toEqual({
    ok: true,
    choice: { kind: 'main_title', playlists: ['00800.mpls'], asEditions: false, editionNames: {} },
  });
});

test('mainTitleChoice - several playlists need editions', () => {
  const result = mainTitleChoice({ playlists: ['1.mpls', '2.mpls'], asEditions: false, editionNames: {} });
  expect(result.ok).toBe(false);
});

test('mainTitleChoice - editions need at least two playlists', () => {
  const result = mainTitleChoice({ playlists: ['1.mpls'], asEditions: true, editionNames: { '1.mpls': 'Extended' } });
  expect(result).toEqual({ ok: false, reason: 'Editions need at least two playlists.' });
});

test('mainTitleChoice - editions need a trimmed name each', () => {
  const result = mainTitleChoice({
    playlists: ['1.mpls', '2.mpls'],
    asEditions: true,
    editionNames: { '1.mpls': 'Theatrical', '2.mpls': '  ' },
  });
  expect(result).toEqual({ ok: false, reason: 'Name the edition for 2.mpls.' });
});

test('mainTitleChoice - edition names must differ', () => {
  const result = mainTitleChoice({
    playlists: ['1.mpls', '2.mpls'],
    asEditions: true,
    editionNames: { '1.mpls': 'Cut', '2.mpls': 'cut' },
  });
  expect(result.ok).toBe(false);
});

test('mainTitleChoice - valid editions keep only the chosen names, trimmed and de-duplicated', () => {
  const result = mainTitleChoice({
    playlists: ['1.mpls', '2.mpls', '1.mpls'],
    asEditions: true,
    editionNames: { '1.mpls': ' Theatrical ', '2.mpls': 'Extended', '3.mpls': 'Unused' },
  });
  expect(result).toEqual({
    ok: true,
    choice: {
      kind: 'main_title',
      playlists: ['1.mpls', '2.mpls'],
      asEditions: true,
      editionNames: { '1.mpls': 'Theatrical', '2.mpls': 'Extended' },
    },
  });
});
