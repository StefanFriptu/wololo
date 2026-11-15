<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { attempt } from '#lib/attempt.ts';

  let { libraryId, onfinished }: { libraryId?: number; onfinished?: () => void } = $props();

  const scan = new Resource((signal) => api('GET /api/v1/scans/current', { signal }));
  let busy = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    untrack(() => scan.load());
  });

  $effect(() =>
    live.on((event) => {
      if (event.name === 'scan.started') scan.load({ silent: true });
      if (event.name === 'scan.progress') {
        const current = scan.data;
        if (current?.scanId !== event.payload.scanId) return void scan.load({ silent: true });
        scan.set({ ...current, running: true, stats: event.payload.stats, currentPath: event.payload.currentPath });
      }
      if (event.name === 'scan.finished') {
        scan.load({ silent: true });
        onfinished?.();
      }
    }),
  );

  $effect(() => live.onReconnect(() => scan.load({ silent: true })));

  $effect(() => {
    if (!scan.data?.running) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function start(force: boolean): Promise<void> {
    if (force && !confirm('Re-probe every file, even unchanged ones? This takes much longer than a normal scan.')) return;
    busy = true;
    const result = await attempt(() => api('POST /api/v1/scans', { body: { libraryId, force } }), 'Scan started');
    if (result) scan.set(result);
    busy = false;
  }

  async function cancel(): Promise<void> {
    busy = true;
    await attempt(() => api('DELETE /api/v1/scans/current'), 'Scan cancelled');
    await scan.load({ silent: true });
    busy = false;
  }
</script>

<section class="card scan" aria-label="Library scan">
  {#if scan.data?.running}
    {@const status = scan.data}
    <div class="row">
      <strong>Scanning…</strong>
      <span class="muted">{formatDuration((now - Date.parse(status.startedAt)) / 1000)}</span>
      <span class="spacer"></span>
      <button class="small" onclick={cancel} disabled={busy}><Icon name="close" size={14} /> Cancel scan</button>
    </div>
    <p class="muted scan-stats" role="status">
      {status.stats.filesSeen} seen · {status.stats.filesNew} new · {status.stats.filesChanged} changed ·
      {status.stats.filesProbed} probed · {status.stats.probeErrors} errors · {status.stats.jobsQueued} queued
    </p>
    {#if status.currentPath}<p class="muted path break">{status.currentPath}</p>{/if}
  {:else}
    <div class="row">
      {#if scan.error && scan.data === undefined}
        <span class="muted">Scan status unavailable: {errorMessage(scan.error)}</span>
      {:else if scan.data}
        <span class="muted">
          Last scan finished {scan.data.finishedAt ? new Date(scan.data.finishedAt).toLocaleString() : ''}:
          {scan.data.stats.filesSeen} files, {scan.data.stats.filesProbed} probed{scan.data.error
            ? `, error: ${scan.data.error}`
            : ''}.
        </span>
      {:else}
        <span class="muted">No scan has run since Wololo started.</span>
      {/if}
      <span class="spacer"></span>
      <button class="primary small" onclick={() => start(false)} disabled={busy}>
        <Icon name="refresh" size={14} /> Scan {libraryId ? 'library' : 'all'}
      </button>
      <button class="small" onclick={() => start(true)} disabled={busy}>Full rescan</button>
    </div>
  {/if}
</section>

<style>
  .scan {
    padding: 0.6rem 1rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .scan-stats,
  .path {
    margin: 0.35rem 0 0;
    font-size: 0.9em;
  }
</style>
