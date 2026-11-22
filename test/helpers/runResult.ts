import type { RunResult } from '../../src/core/process.ts';

/** A clean, instant exit 0 with empty output; override what the test cares about. */
export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    argv: [],
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
