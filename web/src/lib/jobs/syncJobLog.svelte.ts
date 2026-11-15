import { untrack } from 'svelte';
import type { Resource } from '#lib/resource.svelte.ts';
import type { JobDetail } from '#lib/shared.ts';

/**
 * Keeps a job's log in step with the job without reacting to every progress event: the log loads when it first
 * exists and on each start/finish, and while the job runs a timer polls it (or the job detail, until the log exists).
 */
export function syncJobLog(job: Resource<JobDetail>, log: Resource<string>, pollMs: number): void {
  const hasLog = $derived(job.data?.hasLog === true);
  const running = $derived(job.data?.state === 'running');

  $effect(() => {
    if (!hasLog) return;
    void running;
    untrack(() => log.load({ silent: log.data !== undefined }));
  });

  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (job.data?.hasLog !== true) {
        if (!job.inFlight) job.load({ silent: true });
        return;
      }
      if (!log.inFlight) log.load({ silent: true });
    }, pollMs);
    return () => clearInterval(timer);
  });
}
