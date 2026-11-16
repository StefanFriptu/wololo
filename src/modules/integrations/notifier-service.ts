import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppContext } from '../../app/context.ts';
import type { FileChangedEvent, NotifierService } from '../../contracts/integrations.ts';
import type { ArrItemRef } from '../../shared/domain.ts';
import { isTransientUpstreamError } from './upstream.ts';

export interface NotifierDeps {
  /** Waits before each background retry of a transient failure; pending retries are dropped on shutdown or restart. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

async function folderOf(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ? path : dirname(path);
}

export function createNotifierService(ctx: AppContext, deps: NotifierDeps = {}): NotifierService {
  const log = ctx.logs.logger('notifier');
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));

  const retryLater = async (what: string, event: FileChangedEvent, run: () => Promise<void>) => {
    for (const [index, delayMs] of retryDelaysMs.entries()) {
      const slept = await sleep(delayMs, ctx.shutdownSignal).then(
        () => true,
        () => false,
      );
      if (!slept) return;
      try {
        await run();
        log.info(`${what} succeeded on retry`, { path: event.localPath, jobId: event.jobId, attempts: index + 2 });
        return;
      } catch (error) {
        if (isTransientUpstreamError(error) && index < retryDelaysMs.length - 1) continue;
        log.error(`${what} failed`, { path: event.localPath, jobId: event.jobId, attempts: index + 2, error });
        return;
      }
    }
  };

  const attempt = async (what: string, event: FileChangedEvent, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      if (!isTransientUpstreamError(error) || retryDelaysMs.length === 0) {
        log.error(`${what} failed`, { path: event.localPath, jobId: event.jobId, error });
        return;
      }
      log.warn(`${what} failed; retrying in the background`, { path: event.localPath, jobId: event.jobId, error });
      void retryLater(what, event, run);
    }
  };

  const resolveRef = async (event: FileChangedEvent): Promise<ArrItemRef | null> => {
    if (event.arr) return event.arr;
    const found = await ctx.services.arr.findByPath(event.localPath);
    return found?.ref ?? null;
  };

  const rescanArr = (event: FileChangedEvent) =>
    attempt('arr rescan', event, async () => {
      const ref = await resolveRef(event);
      if (!ref) {
        log.warn('no Radarr/Sonarr item owns this file; skipping the rescan', {
          path: event.localPath,
          jobId: event.jobId,
        });
        return;
      }
      await ctx.services.arr.rescan(ref);
    });

  const refreshPlex = (event: FileChangedEvent) =>
    attempt('Plex partial scan', event, async () => ctx.services.plex.refreshPath(await folderOf(event.localPath)));

  return {
    fileChanged: async (event) => {
      if (event.kind === 'replaced' && ctx.settings.section('notifications').rescanArr) await rescanArr(event);
      await refreshPlex(event);
    },
  };
}
