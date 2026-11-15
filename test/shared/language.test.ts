import { expect, test } from 'bun:test';
import { normalizeLanguage, sameLanguage } from '../../src/shared/language.ts';

test.each([
  ['eng', 'eng'],
  ['ENG', 'eng'],
  ['ger', 'ger'],
  ['deu', 'ger'],
  ['de', 'ger'],
  ['de-AT', 'ger'],
  ['German', 'ger'],
  ['fre', 'fre'],
  ['fra', 'fre'],
  ['chi', 'chi'],
  ['zho', 'chi'],
  ['zh-Hans', 'chi'],
  ['pt-BR', 'por'],
  ['Portuguese (Brazil)', 'por'],
  ['Spanish (Latino)', 'spa'],
  ['Flemish', 'dut'],
  ['nld', 'dut'],
  ['ron', 'rum'],
  ['srp', 'srp'],
  ['tlh', 'tlh'],
  ['und', null],
  ['zxx', null],
  ['', null],
  ['Unknown', null],
  ['Original', null],
  ['xx-YY', null],
  [null, null],
  [undefined, null],
])('normalizeLanguage(%p) -> %p', (input, expected) => {
  expect(normalizeLanguage(input)).toBe(expected);
});

test.each([
  ['ger', 'deu', true],
  ['de', 'German', true],
  ['eng', 'ger', false],
  ['und', 'und', false],
  [null, null, false],
])('sameLanguage(%p, %p) -> %p', (a, b, expected) => {
  expect(sameLanguage(a, b)).toBe(expected);
});
