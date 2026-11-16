import { stat } from 'node:fs/promises';
import type { AppContext } from '../../app/context.ts';
import type { ProbeOptions, ProbeService } from '../../contracts/probe-scan.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import { runProcess } from '../../core/process.ts';
import { buildProbeArgs } from './args.ts';
import { parseFfprobeOutput } from './parse.ts';

const PROBE_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_PROBES = 2;

/** FIFO slots; a caller aborted while waiting leaves the queue and gets false, so it never starts a process. */
function createLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  const acquire = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false);
    if (running < limit) {
      running += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        waiting.splice(waiting.indexOf(start), 1);
        resolve(false);
      };
      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      };
      waiting.push(start);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return { acquire, release };
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path).catch((error: unknown) => {
    throw new AppError('not_found', `cannot read ${path}: ${errorMessage(error)}`);
  });
  return info.isFile() ? info.size : 0;
}

export function createProbeService(ctx: AppContext): ProbeService {
  const log = ctx.logs.logger('probe');
  const limiter = createLimiter(MAX_CONCURRENT_PROBES);

  const probe = async (path: string, options: ProbeOptions = {}) => {
    const sizeBytes = await fileSize(path);
    const command = ctx.config.get().tools.ffprobe;
    if (!(await limiter.acquire(options.signal))) throw new AppError('upstream', `ffprobe aborted for ${path}`);
    const result = await runProcess({
      command,
      args: buildProbeArgs(path, options),
      signal: options.signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      lowPriority: false,
    })
      .catch((error: unknown) => {
        throw new AppError('upstream', `cannot run ${command}: ${errorMessage(error)}`);
      })
      .finally(limiter.release);
    if (result.aborted) throw new AppError('upstream', `ffprobe aborted for ${path}`);
    if (result.timedOut) throw new AppError('upstream', `ffprobe timed out for ${path}`);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
      log.debug('ffprobe failed', { path, exitCode: result.exitCode, stderr: detail });
      throw new AppError('upstream', `ffprobe failed (exit ${result.exitCode}): ${detail || 'no output'}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new AppError('upstream', `ffprobe returned invalid JSON for ${path}`);
    }
    return parseFfprobeOutput(raw, path, sizeBytes, new Date().toISOString());
  };

  return { probe };
}
