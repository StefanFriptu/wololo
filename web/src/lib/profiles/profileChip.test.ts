import { expect, test } from 'bun:test';
import type { PlanAction, ProfileResult } from '#lib/shared.ts';
import { profileChip } from './profileChip.ts';

const result = (action: PlanAction, failingCodecs: string[] = []): ProfileResult => ({
  profileId: 1,
  action,
  failingCodecs,
  failingStreams: [],
});

test('profileChip - skip is green and shows the name alone', () => {
  expect(profileChip(result('skip'), 'Tizen')).toEqual({ label: 'Tizen', tone: 'success' });
});

test.each(['remux', 'convert', 'blocked'] as const)('profileChip - %p is red', (action) => {
  expect(profileChip(result(action), 'Tizen').tone).toBe('danger');
});

test('profileChip - a failing profile names its first failing codec', () => {
  expect(profileChip(result('convert', ['eac3', 'dts']), 'Tizen').label).toBe('Tizen · eac3');
});

test('profileChip - a failing profile without codecs shows the name alone', () => {
  expect(profileChip(result('blocked'), 'Tizen').label).toBe('Tizen');
});
