import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { errorMessage } from '../../core/errors.ts';
import { withTimeout } from './withTimeout.ts';

export interface RootProbeDeps {
  stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  access: (path: string, mode: number) => Promise<void>;
  timeoutMs: number;
}

export const ROOT_PROBE_TIMEOUT_MS = 3000;

const FS_DEPS: RootProbeDeps = { stat, access, timeoutMs: ROOT_PROBE_TIMEOUT_MS };

async function probe(path: string, deps: RootProbeDeps): Promise<string | null> {
  try {
    if (!(await deps.stat(path)).isDirectory()) return 'not a directory';
    await deps.access(path, constants.R_OK | constants.X_OK);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? errorMessage(error);
  }
}

/** null when the library root is a readable directory, else what is wrong; a hung network mount reports a timeout. */
export function rootProblem(path: string, deps: RootProbeDeps = FS_DEPS): Promise<string | null> {
  return withTimeout(probe(path, deps), deps.timeoutMs, `no answer within ${deps.timeoutMs / 1000} s (hung mount?)`);
}
