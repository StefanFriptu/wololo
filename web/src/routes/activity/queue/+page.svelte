<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import ProgressBar from '#lib/components/ProgressBar.svelte';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { formatRelativeTime } from '#lib/format/formatRelativeTime.ts';
  import { formatSpeed } from '#lib/format/formatSpeed.ts';
  import { applyQueueEvent } from '#lib/jobs/applyQueueEvent.ts';
  import { attemptNumber } from '#lib/jobs/attemptNumber.ts';
  import { JOB_STATE_LABELS, JOB_STATE_TONES, JOB_STEP_LABELS, JOB_TRIGGER_LABELS, PAUSE_REASON_LABELS } from '#lib/labels.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { JobSummary } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const queue = new Resource((signal) => api('GET /api/v1/queue', { signal }));
  const settings = new Resource((signal) => api('GET /api/v1/settings', { signal }));
  let busy = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    untrack(() => {
      queue.load();
      settings.load();
    });
  });

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  $effect(() =>
    live.on((event) => {
      if (event.name === 'settings.changed' && event.payload.sections.includes('processing')) settings.load({ silent: true });
      const current = queue.data;
      if (!current) return;
      if (event.name === 'queue.state') {
        queue.set({ ...current, state: event.payload });
        return;
      }
      const items = applyQueueEvent(current.items, event);
      if (items !== current.items) queue.set({ ...current, items: [...items] });
    }),
  );
  $effect(() => live.onReconnect(() => queue.load({ silent: true })));

  async function togglePause(paused: boolean): Promise<void> {
    busy = true;
    const state = await attempt(() => api(paused ? 'POST /api/v1/queue/resume' : 'POST /api/v1/queue/pause'));
    if (state && queue.data) queue.set({ ...queue.data, state });
    busy = false;
  }

  async function cancel(job: JobSummary): Promise<void> {
    if (job.state === 'running' && !confirm(`Stop "${job.title}"? The original file stays untouched.`)) return;
    await attempt(() => api('POST /api/v1/jobs/:id/cancel', { params: { id: job.id } }), 'Job cancelled');
  }

  async function remove(job: JobSummary): Promise<void> {
    try {
      await api('DELETE /api/v1/jobs/:id', { params: { id: job.id } });
      toasts.success('Job removed');
      if (queue.data) queue.set({ ...queue.data, items: queue.data.items.filter((item) => item.id !== job.id) });
    } catch (error) {
      toasts.error(error);
    }
  }
</script>

<PageHeader title="Queue">
  {#snippet actions()}
    {#if queue.data}
      {@const paused = queue.data.state.pauseReasons.includes('user')}
      <button onclick={() => togglePause(paused)} disabled={busy}>
        <Icon name={paused ? 'play' : 'pause'} size={16} />
        {paused ? 'Resume' : 'Pause'}
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if settings.data && !settings.data.processing.enabled}
  <div class="alert tone-warning">
    <p>
      Processing is off (dry-run mode): nothing is converted until you turn it on in
      <a href={href('/settings/media')}>Settings > Media</a>.
    </p>
  </div>
{/if}

<Async resource={queue}>
  {#snippet children(data)}
    <p class="state muted" role="status">
      {data.state.running} running of {data.state.concurrency} · {data.state.queued} queued
      {#each data.state.pauseReasons as reason (reason)}
        <Badge tone="warning" label={PAUSE_REASON_LABELS[reason]} />
      {/each}
    </p>
    {#if data.items.length === 0}
      <section class="card empty">
        <p class="muted">The queue is empty. Imports from Radarr/Sonarr and scans add files that need work.</p>
      </section>
    {:else}
      <section class="card">
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Queued and running jobs</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Progress</th>
                <th scope="col" class="num hide-sm">Speed</th>
                <th scope="col" class="num">ETA</th>
                <th scope="col" class="hide-sm">Trigger</th>
                <th scope="col" class="hide-sm">Added</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each data.items as job (job.id)}
                <tr>
                  <td class="title">
                    <a href={href(`/activity/jobs/${job.id}`)}>{job.title}</a>
                    <div class="muted small">{job.type === 'bdmv' ? 'Blu-ray' : 'Audio'}{attemptNumber(job) > 1 ? ` · attempt ${attemptNumber(job)}` : ''}</div>
                  </td>
                  <td>
                    <Badge tone={JOB_STATE_TONES[job.state]} label={JOB_STATE_LABELS[job.state]} />
                    {#if job.state === 'running'}<div class="muted small">{JOB_STEP_LABELS[job.step]}</div>{/if}
                  </td>
                  <td class="progress-cell">
                    {#if job.state === 'running'}<ProgressBar value={job.progress} label="Progress of {job.title}" />{:else}<span class="muted">-</span>{/if}
                  </td>
                  <td class="num hide-sm">{formatSpeed(job.speed)}</td>
                  <td class="num">{job.etaSec === null ? '-' : formatDuration(job.etaSec)}</td>
                  <td class="hide-sm">{JOB_TRIGGER_LABELS[job.trigger]}</td>
                  <td class="hide-sm nowrap">{formatRelativeTime(job.createdAt, now)}</td>
                  <td class="actions">
                    <button class="small" onclick={() => cancel(job)} aria-label="Cancel {job.title}" title="Cancel">
                      <Icon name="close" size={14} />
                    </button>
                    {#if job.state === 'queued'}
                      <button class="small" onclick={() => remove(job)} aria-label="Remove {job.title}" title="Remove">
                        <Icon name="trash" size={14} />
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  {/snippet}
</Async>

<style>
  .state {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .title {
    min-width: 12rem;
    overflow-wrap: anywhere;
  }
  .small {
    font-size: 0.85em;
  }
  .progress-cell {
    min-width: 8rem;
  }
  .empty {
    text-align: center;
  }
</style>
