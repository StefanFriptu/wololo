import { appendFileSync } from 'node:fs';
import type { JobLog } from '../../contracts/jobs.ts';
import { errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';

/** Appends timestamped lines to <config>/logs/jobs/<jobId>.txt; a failing write is logged once and never breaks the job. */
export function createJobLog(path: string, options: { log: Logger; now?: () => Date }): JobLog {
  const now = options.now ?? (() => new Date());
  let failed = false;
  const write = (text: string) => {
    try {
      appendFileSync(path, text);
    } catch (error) {
      if (failed) return;
      failed = true;
      options.log.warn('cannot write job log', { path, error: errorMessage(error) });
    }
  };
  return {
    line: (text) => write(`${now().toISOString()} ${text}\n`),
    section: (title) => write(`${now().toISOString()} ==== ${title} ====\n`),
  };
}
