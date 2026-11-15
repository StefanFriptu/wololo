import { expect, test } from 'bun:test';
import { plexFlagWrites } from './plexFlagWrites.ts';

test.each([true, false])('plexFlagWrites - partial scan %p sets both stored flags', (value) => {
  expect(plexFlagWrites('partialScan', value)).toEqual({
    plex: { partialScan: value },
    settings: { notifications: { plexPartialScan: value } },
  });
});

test.each([true, false])('plexFlagWrites - pause while streaming %p sets both stored flags', (value) => {
  expect(plexFlagWrites('pauseWhileStreaming', value)).toEqual({
    plex: { pauseWhileStreaming: value },
    settings: { processing: { pauseWhilePlexStreaming: value } },
  });
});
