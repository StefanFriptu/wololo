import { expect, test } from 'bun:test';
import { formatChannels } from './formatChannels.ts';

test.each([
  [6, '5.1(side)', '5.1'],
  [8, '7.1', '7.1'],
  [2, 'stereo', '2.0'],
  [1, 'mono', '1.0'],
  [6, null, '5.1'],
  [8, undefined, '7.1'],
  [5, 'unknown', '5.0'],
  [16, null, '16ch'],
  [0, null, '-'],
  [null, null, '-'],
])('formatChannels - %p channels with layout %p render %p', (channels, layout, expected) => {
  expect(formatChannels(channels, layout)).toBe(expected);
});
