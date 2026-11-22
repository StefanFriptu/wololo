import { expect, test } from 'bun:test';
import { AppError } from '../../src/core/errors.ts';
import { assertRanOk, type RunResult } from '../../src/core/process.ts';

function ran(overrides: Partial<RunResult> = {}): RunResult {
  return {
    argv: ['tool'],
    exitCode: 0,
    signalCode: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    aborted: false,
    timedOut: false,
    ...overrides,
  };
}

function failure(result: RunResult, options: Parameters<typeof assertRanOk>[1]): AppError {
  try {
    assertRanOk(result, options);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('assertRanOk did not throw');
}

test('assertRanOk - exit 0 passes', () => {
  expect(() => assertRanOk(ran(), { label: 'tool' })).not.toThrow();
});

test('assertRanOk - a non-zero exit fails with the exit code and the stderr tail', () => {
  const error = failure(ran({ exitCode: 2, stderr: '  boom\n' }), { label: 'tool' });
  expect(error.code).toBe('internal');
  expect(error.message).toBe('tool failed (exit 2): boom');
});

test('assertRanOk - a null exit code fails', () => {
  expect(failure(ran({ exitCode: null }), { label: 'tool' }).message).toBe('tool failed (exit null): ');
});

test('assertRanOk - okExitCodes widens what counts as success', () => {
  expect(() => assertRanOk(ran({ exitCode: 1 }), { label: 'tool', okExitCodes: [0, 1] })).not.toThrow();
  expect(failure(ran({ exitCode: 2 }), { label: 'tool', okExitCodes: [0, 1] }).message).toContain('exit 2');
  expect(failure(ran({ exitCode: null }), { label: 'tool', okExitCodes: [0, 1] }).message).toContain('exit null');
});

test('assertRanOk - a cancelled run is reported before the exit code', () => {
  const error = failure(ran({ aborted: true, exitCode: 0 }), { label: 'tool', failureCode: 'upstream' });
  expect(error.code).toBe('internal');
  expect(error.message).toBe('tool was cancelled');
});

test('assertRanOk - a timed out run is reported as a timeout, not as exit null', () => {
  const error = failure(ran({ timedOut: true, exitCode: null }), {
    label: 'tool',
    failureLabel: 'tool run',
    failureCode: 'upstream',
  });
  expect(error.code).toBe('upstream');
  expect(error.message).toBe('tool run timed out');
});

test('assertRanOk - failureLabel, failureCode and stderrTail shape the failed message', () => {
  const error = failure(ran({ exitCode: 3, stderr: 'abcdefghij' }), {
    label: 'tool',
    failureLabel: 'tool x',
    failureCode: 'upstream',
    stderrTail: 4,
  });
  expect(error.code).toBe('upstream');
  expect(error.message).toBe('tool x failed (exit 3): ghij');
});
