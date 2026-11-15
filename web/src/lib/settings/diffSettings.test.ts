import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, type Settings } from '#lib/shared.ts';
import { diffSettings } from './diffSettings.ts';

const copy = (): Settings => structuredClone(DEFAULT_SETTINGS);

test('diffSettings - identical settings give null', () => {
  expect(diffSettings(copy(), copy())).toBeNull();
});

test('diffSettings - a nested change sends only that leaf, so a concurrent queue pause is not overwritten', () => {
  const edited = copy();
  edited.processing.window.enabled = true;
  expect(diffSettings(copy(), edited)).toEqual({ processing: { window: { enabled: true } } });
});

test('diffSettings - array changes are detected', () => {
  const edited = copy();
  edited.media.extensions = [...edited.media.extensions, '.webm'];
  edited.recycleBin.retentionDays = 14;
  expect(diffSettings(copy(), edited)).toEqual({
    media: { extensions: edited.media.extensions },
    recycleBin: { retentionDays: 14 },
  });
});
