import { expect, test } from 'bun:test';
import type { DiscoveredEntry } from '../../contracts/probe-scan.ts';
import type { MediaFileStatus } from '../../shared/domain.ts';
import { classifyEntry, needsRecheck } from './change-detection.ts';

const entry: DiscoveredEntry = { path: '/m/a.mkv', kind: 'file', sizeBytes: 1000, mtimeMs: 1_700_000_000_123.75 };
const stored = (
  overrides: Partial<{ sizeBytes: number; mtimeMs: number; rulesKey: string | null; status: MediaFileStatus }> = {},
) => ({
  sizeBytes: 1000,
  mtimeMs: 1_700_000_000_123,
  rulesKey: 'k1',
  status: 'compatible' as MediaFileStatus,
  ...overrides,
});

test.each([
  ['new file', null, 'k1', false, true],
  ['unchanged', stored(), 'k1', false, false],
  ['unchanged needs_work', stored({ status: 'needs_work' }), 'k1', false, false],
  ['unchanged failed', stored({ status: 'failed' }), 'k1', false, false],
  ['size changed', stored({ sizeBytes: 999 }), 'k1', false, true],
  ['mtime changed', stored({ mtimeMs: 1_700_000_000_124 }), 'k1', false, true],
  ['rules key changed (profile edit)', stored(), 'k2', false, true],
  ['never evaluated rules key', stored({ rulesKey: null }), 'k1', false, true],
  ['pending re-check', stored({ status: 'pending' }), 'k1', false, true],
  ['force', stored(), 'k1', true, true],
  ['ignored, changed', stored({ status: 'ignored', sizeBytes: 1 }), 'k2', false, false],
  ['ignored, force', stored({ status: 'ignored' }), 'k1', true, true],
  ['processing, changed', stored({ status: 'processing', sizeBytes: 1 }), 'k1', false, false],
  ['processing, force', stored({ status: 'processing' }), 'k1', true, true],
] as const)('needsRecheck - %s', (_label, row, key, force, expected) => {
  expect(needsRecheck(entry, row, key, force)).toBe(expected);
});

test.each([
  ['/m/Movie.mkv', false, [], 'file'],
  ['/m/Disc.ISO', false, [], 'iso'],
  ['/m/Disc', true, ['BDMV', 'CERTIFICATE', 'BDMV/index.bdmv', 'BDMV/PLAYLIST'], 'bdmv'],
  ['/m/Disc', true, ['bdmv', 'bdmv/INDEX.BDMV'], 'bdmv'],
  ['/m/Disc', true, ['BDMV', 'BDMV/STREAM'], null],
  ['/m/Movie (2020)', true, ['Movie.mkv'], null],
  ['/m/Disc/BDMV', true, ['index.bdmv'], null],
  ['/m/empty', true, [], null],
] as const)('classifyEntry - %s (dir %p) -> %p', (path, isDirectory, children, expected) => {
  expect(classifyEntry(path, isDirectory, [...children])).toBe(expected);
});
