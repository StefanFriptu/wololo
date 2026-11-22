import { expect, test } from 'bun:test';
import type { DeviceProfileDefinition } from '#lib/shared.ts';
import { audioProblems } from './audioLimits.ts';

const audio = (overrides: Partial<DeviceProfileDefinition['audio']> = {}): DeviceProfileDefinition['audio'] => ({
  allowedCodecs: ['ac3', 'eac3', 'aac'],
  targetCodec: 'ac3',
  bitrates: { mono: 192, stereo: 448, surround: 640 },
  maxChannels: 6,
  ...overrides,
});

test('audioProblems - a valid audio section has none', () => {
  expect(audioProblems(audio())).toEqual([]);
});

test('audioProblems - target codec missing from the allowed list', () => {
  const problems = audioProblems(audio({ allowedCodecs: ['ac3'], targetCodec: 'eac3' }));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('Tick EAC3');
});

test('audioProblems - a wildcard entry covers the target codec', () => {
  expect(audioProblems(audio({ allowedCodecs: ['e*'], targetCodec: 'eac3' }))).toEqual([]);
});

test('audioProblems - AC3 bit rate above 640 kbps', () => {
  expect(audioProblems(audio({ bitrates: { mono: 192, stereo: 448, surround: 700 } }))).toEqual([
    'AC3 bit rates cannot exceed 640 kbps.',
  ]);
});

test('audioProblems - E-AC3 allows 700 kbps but not 2000', () => {
  expect(audioProblems(audio({ targetCodec: 'eac3', bitrates: { mono: 192, stereo: 448, surround: 700 } }))).toEqual(
    [],
  );
  expect(audioProblems(audio({ targetCodec: 'eac3', bitrates: { mono: 192, stereo: 448, surround: 2000 } }))).toEqual([
    'EAC3 bit rates cannot exceed 1536 kbps.',
  ]);
});
