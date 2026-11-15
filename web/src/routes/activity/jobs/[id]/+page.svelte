<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import ProgressBar from '#lib/components/ProgressBar.svelte';
  import StreamCompare from '#lib/components/StreamCompare.svelte';
  import { downloadBlob } from '#lib/download.ts';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { formatSpeed } from '#lib/format/formatSpeed.ts';
  import { patchJob } from '#lib/jobs/patchJob.ts';
  import { syncJobLog } from '#lib/jobs/syncJobLog.svelte.ts';
  import {
    JOB_STATE_LABELS,
    JOB_STATE_TONES,
    JOB_STEP_LABELS,
    JOB_TRIGGER_LABELS,
    PLAN_ACTION_LABELS,
    PLAN_ACTION_TONES,
    VERIFICATION_LABELS,
  } from '#lib/labels.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { pairStreams } from '#lib/streams/pairStreams.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const LOG_POLL_MS = 3000;

  const id = $derived(Number(page.params.id));
  const job = new Resource((signal) => api('GET /api/v1/jobs/:id', { params: { id }, signal }));
  const log = new Resource((signal) => api('GET /api/v1/jobs/:id/log', { params: { id }, signal }));
  let follow = $state(true);
  let busy = $state(false);
  let logElement = $state<HTMLPreElement>();

  const active = $derived(job.data?.state === 'running' || job.data?.state === 'queued');

  $effect(() => {
    void id;
    untrack(() => {
      job.reset();
      log.reset();
      job.load();
    });
  });

  syncJobLog(job, log, LOG_POLL_MS);

  $effect(() => {
    void log.data;
    if (!follow || !logElement) return;
    const element = logElement;
    tick().then(() => (element.scrollTop = element.scrollHeight));
  });

  $effect(() =>
    live.on((event) => {
      const current = job.data;
      if (!current) return;
      if (event.name === 'job.removed' && event.payload.jobId === id) {
        toasts.show('info', 'This job was removed.');
        return;
      }
      if (event.name === 'job.finished' && event.payload.job.id === id) {
        job.load({ silent: true });
        return;
      }
      const next = patchJob(current, event);
      if (next !== current) job.set({ ...current, ...next });
      if (event.name === 'job.started' && event.payload.job.id === id) job.load({ silent: true });
    }),
  );
  $effect(() => live.onReconnect(() => job.load({ silent: true })));

  async function cancel(): Promise<void> {
    if (!confirm('Stop this job? The original file stays untouched.')) return;
    busy = true;
    const summary = await attempt(() => api('POST /api/v1/jobs/:id/cancel', { params: { id } }), 'Job cancelled');
    if (summary) await job.load({ silent: true });
    busy = false;
  }

  async function retry(): Promise<void> {
    busy = true;
    const summary = await attempt(() => api('POST /api/v1/jobs/:id/retry', { params: { id } }), 'Job queued again');
    if (summary) await (summary.id === id ? job.load({ silent: true }) : goto(href(`/activity/jobs/${summary.id}`)));
    busy = false;
  }

  async function remove(): Promise<void> {
    if (!confirm('Remove this job and its log?')) return;
    busy = true;
    try {
      await api('DELETE /api/v1/jobs/:id', { params: { id } });
      toasts.success('Job removed');
      await goto(href('/activity/history'));
    } catch (error) {
      toasts.error(error);
    }
    busy = false;
  }

  function saveLog(): void {
    if (log.data === undefined) return;
    downloadBlob(new Blob([log.data], { type: 'text/plain' }), `wololo-job-${id}.txt`);
  }

  function sizeChange(before: number, after: number): string {
    if (before <= 0) return '';
    const percent = ((after - before) / before) * 100;
    return ` (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`;
  }
</script>

<Async resource={job}>
  {#snippet children(data)}
    <PageHeader title={data.title} subtitle="Job #{data.id} · {data.type === 'bdmv' ? 'Blu-ray to MKV' : 'Audio conversion'}">
      {#snippet actions()}
        {#if active}
          <button onclick={cancel} disabled={busy}><Icon name="close" size={16} /> Cancel</button>
        {/if}
        {#if data.state === 'failed' || data.state === 'cancelled'}
          <button class="primary" onclick={retry} disabled={busy}><Icon name="refresh" size={16} /> Retry</button>
        {/if}
        {#if data.state !== 'running'}
          <button onclick={remove} disabled={busy}><Icon name="trash" size={16} /> Remove</button>
        {/if}
      {/snippet}
    </PageHeader>

    {#if data.error}
      <div class="alert tone-danger" role="alert"><p>{data.error}</p></div>
    {/if}

    <section class="card">
      <div class="status">
        <Badge tone={JOB_STATE_TONES[data.state]} label={JOB_STATE_LABELS[data.state]} />
        <span>{JOB_STEP_LABELS[data.step]}</span>
        {#if data.state === 'running'}
          <div class="bar"><ProgressBar value={data.progress} label="Job progress" /></div>
          <span class="muted">{formatSpeed(data.speed)} · ETA {data.etaSec === null ? '-' : formatDuration(data.etaSec)}</span>
        {/if}
      </div>
      <dl class="kv">
        <dt>Source</dt>
        <dd class="break">
          {#if data.mediaFileId !== null}<a href={href(`/library/${data.mediaFileId}`)}>{data.sourcePath}</a>{:else}{data.sourcePath}{/if}
        </dd>
        {#if data.outputPath}
          <dt>Output</dt>
          <dd class="break">{data.outputPath}</dd>
        {/if}
        <dt>Trigger</dt>
        <dd>{JOB_TRIGGER_LABELS[data.trigger]}{data.attempts > 0 ? ` · ${data.attempts} earlier attempt(s)` : ''}</dd>
        <dt>Added</dt>
        <dd>{formatDateTime(data.createdAt)}</dd>
        <dt>Started</dt>
        <dd>{formatDateTime(data.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>
          {formatDateTime(data.finishedAt)}
          {#if data.startedAt && data.finishedAt}
            <span class="muted">(took {formatDuration((Date.parse(data.finishedAt) - Date.parse(data.startedAt)) / 1000)})</span>
          {/if}
        </dd>
        {#if data.bytesBefore !== null && data.bytesAfter !== null}
          <dt>Size</dt>
          <dd>{formatBytes(data.bytesBefore)} → {formatBytes(data.bytesAfter)}{sizeChange(data.bytesBefore, data.bytesAfter)}</dd>
        {/if}
        {#if data.recycleBinEntryId !== null}
          <dt>Original</dt>
          <dd>Kept in the <a href={href('/activity/recyclebin')}>recycle bin</a></dd>
        {/if}
      </dl>
    </section>

    {#if data.lostFeatures.length > 0}
      <div class="alert tone-warning">
        <strong>What was lost</strong>
        <ul class="bullets">
          {#each data.lostFeatures as feature, index (index)}<li>{feature}</li>{/each}
        </ul>
      </div>
    {/if}

    {#if data.plan}
      <section class="card">
        <div class="card-header">
          <h2>Plan</h2>
          <Badge tone={PLAN_ACTION_TONES[data.plan.action]} label={PLAN_ACTION_LABELS[data.plan.action]} />
        </div>
        {#if data.plan.reasons.length > 0}
          <ul class="bullets">
            {#each data.plan.reasons as reason, index (index)}<li>{reason}</li>{/each}
          </ul>
        {/if}
        {#each data.plan.videoNotes as note, index (index)}<p class="muted">{note}</p>{/each}
      </section>
    {/if}

    {#if data.before || data.after}
      <section class="card">
        <h2>Streams before and after</h2>
        <StreamCompare
          caption="Streams before and after the job"
          rows={pairStreams({ before: data.before, plan: data.plan, after: data.after })}
          afterLabel={data.after ? 'After' : 'Planned'}
        />
      </section>
    {/if}

    {#if data.bdmvPlan}
      {@const plan = data.bdmvPlan}
      <section class="card">
        <h2>Blu-ray output</h2>
        <dl class="kv">
          <dt>Movie</dt>
          <dd>{plan.movie.title}{plan.movie.year ? ` (${plan.movie.year})` : ''} · TMDB {plan.movie.tmdbId}</dd>
          <dt>Radarr root</dt>
          <dd class="break">{plan.rootFolderPath}</dd>
          <dt>Source</dt>
          <dd class="break">{plan.sourcePath} ({plan.sourceKind === 'iso' ? 'ISO' : 'folder'})</dd>
          <dt>Space needed</dt>
          <dd>{formatBytes(plan.estimatedOutputBytes + plan.extractBytes)}{plan.extractBytes > 0 ? ` (incl. ${formatBytes(plan.extractBytes)} extracted from the ISO)` : ''}</dd>
          <dt>Dolby Vision</dt>
          <dd>Keep the HDR10 base layer</dd>
        </dl>
        <ul class="list-plain titles">
          {#each plan.titles as title (title.outputPath)}
            <li>
              <Badge tone={title.role === 'extra' ? 'neutral' : 'info'} label={title.edition ?? title.role} />
              <span class="mono">{title.playlist}</span> → <span class="break">{title.outputPath}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if data.verification}
      <section class="card">
        <div class="card-header">
          <h2>Verification</h2>
          <Badge tone={data.verification.passed ? 'success' : 'danger'} label={data.verification.passed ? 'Passed' : 'Failed'} />
        </div>
        <ul class="list-plain checks">
          {#each data.verification.checks as check (check.name)}
            <li>
              <span class="result tone-{check.passed ? 'success' : 'danger'}" aria-label={check.passed ? 'passed' : 'failed'}>
                <Icon name={check.passed ? 'check' : 'close'} size={14} />
              </span>
              <strong>{VERIFICATION_LABELS[check.name]}</strong>
              <span class="muted">{check.detail}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="card">
      <div class="card-header">
        <h2>Log</h2>
        {#if data.hasLog}
          <div class="toolbar">
            <label class="check"><input type="checkbox" bind:checked={follow} /> Follow</label>
            <button class="small" onclick={() => log.load()}><Icon name="refresh" size={14} /> Reload</button>
            <button class="small" onclick={saveLog} disabled={log.data === undefined}><Icon name="download" size={14} /> Download</button>
          </div>
        {/if}
      </div>
      {#if data.hasLog}
        <Async resource={log} isEmpty={(text) => text.length === 0} emptyText="The log is empty.">
          {#snippet children(text)}
            <pre class="log" bind:this={logElement} aria-label="Job log">{text}</pre>
          {/snippet}
        </Async>
      {:else}
        <p class="muted">{active ? 'The log appears once the job starts.' : 'This job has no log.'}</p>
      {/if}
    </section>
  {/snippet}
</Async>

<style>
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-bottom: 1rem;
  }
  .bar {
    flex: 1;
    min-width: 10rem;
    max-width: 24rem;
  }
  .checks li,
  .titles li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    align-items: center;
    padding: 0.35rem 0;
  }
  .titles {
    margin-top: 0.75rem;
  }
  .result {
    display: inline-flex;
    border-radius: 50%;
    padding: 0.15rem;
  }
</style>
