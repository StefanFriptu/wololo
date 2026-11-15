import { expect, test } from 'bun:test';
import { COPY_BYTES_PER_SECOND, estimateJobSeconds, estimateOutputBytes, peakTempBytes } from './estimate.ts';

const GB = 1024 * 1024 * 1024;

test.each([
  ['convert, encode bound', 'convert', 7200, 4 * GB, null, 7.7, Math.round(7200 / 7.7)],
  ['convert, I/O bound', 'convert', 600, 40 * GB, null, 7.7, Math.round((40 * GB) / COPY_BYTES_PER_SECOND)],
  ['remux never encodes', 'remux', 7200, 4 * GB, null, 7.7, Math.round((4 * GB) / COPY_BYTES_PER_SECOND)],
  ['larger output dominates I/O', 'remux', null, GB, 2 * GB, 7.7, Math.round((2 * GB) / COPY_BYTES_PER_SECOND)],
  ['unknown duration', 'convert', null, GB, null, 7.7, Math.round(GB / COPY_BYTES_PER_SECOND)],
  ['zero speed factor', 'convert', 7200, 0, null, 0, 0],
] as const)('estimateJobSeconds - %s', (_label, planAction, durationSec, sizeBytes, outputBytes, speed, expected) => {
  expect(estimateJobSeconds({ planAction, durationSec, sizeBytes, estimatedOutputBytes: outputBytes }, speed)).toBe(
    expected,
  );
});

test.each([
  [null, 1000, 1000],
  [800, 1000, 800],
  [0, 1000, 0],
])('estimateOutputBytes - plan estimate %p, size %d -> %d', (estimate, size, expected) => {
  expect(
    estimateOutputBytes({ planAction: 'convert', durationSec: 1, sizeBytes: size, estimatedOutputBytes: estimate }),
  ).toBe(expected);
});

test.each([
  [1000, 5, 1050],
  [1000, 0, 1000],
  [0, 5, 0],
])('peakTempBytes - %d bytes with %d%% margin -> %d', (bytes, margin, expected) => {
  expect(peakTempBytes(bytes, margin)).toBe(expected);
});
