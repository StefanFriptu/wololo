import { expect, test } from 'bun:test';
import { decideRecovery, type RecoveryAction, type RecoveryInput } from './recovery.ts';

const replacing = (overrides: Partial<RecoveryInput>): RecoveryInput => ({
  type: 'audio',
  step: 'replacing',
  tempExists: false,
  sourceExists: false,
  outputExists: false,
  samePath: true,
  tempIsOutput: false,
  hasBinEntry: false,
  ...overrides,
});

test.each<[string, Partial<RecoveryInput>, RecoveryAction]>([
  [
    'temp + original: rename never happened',
    { tempExists: true, sourceExists: true, outputExists: true, hasBinEntry: true },
    'keep_original',
  ],
  ['temp + original, bin disabled', { tempExists: true, sourceExists: true, outputExists: true }, 'keep_original'],
  ['temp, no original: fallback move happened', { tempExists: true, hasBinEntry: true }, 'finish_rename'],
  [
    'no temp, original present: swap completed',
    { sourceExists: true, outputExists: true, hasBinEntry: true },
    'complete',
  ],
  ['no temp, original present, bin disabled', { sourceExists: true, outputExists: true }, 'complete'],
  ['nothing left but the bin', { hasBinEntry: true }, 'restore_from_bin'],
  ['nothing left at all', {}, 'fail_source_missing'],
  ['mp4 source: temp + source, no output', { samePath: false, tempExists: true, sourceExists: true }, 'keep_original'],
  ['mp4 source: moved to bin, temp left', { samePath: false, tempExists: true, hasBinEntry: true }, 'finish_rename'],
  [
    'mp4 source: output written, old source left',
    { samePath: false, sourceExists: true, outputExists: true },
    'complete_remove_source',
  ],
  ['mp4 source: output written, source gone', { samePath: false, outputExists: true, hasBinEntry: true }, 'complete'],
  ['mp4 source: temp vanished before rename', { samePath: false, sourceExists: true }, 'keep_original'],
  [
    'mp4 source: temp linked to the output, not yet unlinked',
    { samePath: false, tempExists: true, sourceExists: true, outputExists: true, tempIsOutput: true },
    'complete_drop_temp',
  ],
  [
    'mp4 source moved to bin, a foreign file sits at the output path',
    { samePath: false, tempExists: true, outputExists: true, hasBinEntry: true },
    'restore_from_bin',
  ],
  [
    'mp4 source gone, a foreign file at the output path, no bin entry',
    { samePath: false, tempExists: true, outputExists: true },
    'fail_source_missing',
  ],
])('decideRecovery - replacing, %s', (_name, input, expected) => {
  expect(decideRecovery(replacing(input))).toBe(expected);
});

test.each(['waiting', 'preparing', 'encoding', 'muxing', 'verifying', 'importing', 'done'] as const)(
  'decideRecovery - audio step %s re-queues',
  (step) => {
    expect(decideRecovery(replacing({ step, tempExists: true, sourceExists: true }))).toBe('requeue');
  },
);

test.each<[string, Partial<RecoveryInput>, RecoveryAction]>([
  ['mkv replaced in place', { sourceExists: true, outputExists: true }, 'complete'],
  ['mp4 source already removed', { samePath: false, outputExists: true }, 'complete'],
  ['output gone since the swap', { samePath: false }, 'requeue'],
])('decideRecovery - notifying, %s', (_name, input, expected) => {
  expect(decideRecovery(replacing({ step: 'notifying', ...input }))).toBe(expected);
});

test('decideRecovery - bdmv jobs always re-queue', () => {
  expect(decideRecovery(replacing({ type: 'bdmv', tempExists: true }))).toBe('requeue');
  expect(decideRecovery(replacing({ type: 'bdmv', step: 'notifying', outputExists: true }))).toBe('requeue');
});
