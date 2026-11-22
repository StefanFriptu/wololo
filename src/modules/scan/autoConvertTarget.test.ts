import { expect, test } from 'bun:test';
import type { PlanAction, ProfileResult } from '../../shared/domain.ts';
import { type AutoConvertInput, autoConvertTarget } from './autoConvertTarget.ts';

const result = (profileId: number, action: PlanAction): ProfileResult => ({
  profileId,
  action,
  failingCodecs: action === 'skip' ? [] : ['dts'],
  failingStreams: action === 'skip' ? [] : [1],
});

const input = (overrides: Partial<AutoConvertInput> = {}): AutoConvertInput => ({
  media: { importAction: 'convert_for_profile', importProfileId: 2 },
  libraryProfileIds: [1, 2],
  status: 'needs_work',
  profileResults: [result(1, 'convert'), result(2, 'convert')],
  ...overrides,
});

test('autoConvertTarget - check_only queues nothing, even for a file that needs work', () => {
  expect(autoConvertTarget(input({ media: { importAction: 'check_only', importProfileId: null } }))).toBeNull();
});

test.each([
  ['needs_work', { profileId: null }],
  ['compatible', null],
  ['blocked', null],
] as const)('autoConvertTarget - convert_strictest on a %s file -> %p', (status, expected) => {
  const media = { importAction: 'convert_strictest', importProfileId: null } as const;
  expect(autoConvertTarget(input({ media, status }))).toEqual(expected);
});

test.each([
  ['convert', { profileId: 2 }],
  ['remux', { profileId: 2 }],
  ['skip', null],
  ['blocked', null],
] as const)('autoConvertTarget - convert_for_profile when that profile alone plans %s -> %p', (action, expected) => {
  expect(autoConvertTarget(input({ profileResults: [result(1, 'convert'), result(2, action)] }))).toEqual(expected);
});

test('autoConvertTarget - convert_for_profile skips libraries the profile is not assigned to', () => {
  expect(autoConvertTarget(input())).toEqual({ profileId: 2 });
  expect(autoConvertTarget(input({ libraryProfileIds: [1] }))).toBeNull();
});

test('autoConvertTarget - convert_for_profile converts a disc that needs work for the strictest combination', () => {
  expect(autoConvertTarget(input({ profileResults: null }))).toEqual({ profileId: null });
  expect(autoConvertTarget(input({ profileResults: null, status: 'compatible' }))).toBeNull();
});

test('autoConvertTarget - convert_for_profile without a result for the profile queues nothing', () => {
  expect(autoConvertTarget(input({ profileResults: [result(1, 'convert')] }))).toBeNull();
});
