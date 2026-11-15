<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import StreamCompare from '#lib/components/StreamCompare.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import {
    HISTORY_EVENT_LABELS,
    HISTORY_EVENT_TONES,
    JOB_STATE_LABELS,
    JOB_STATE_TONES,
    JOB_STEP_LABELS,
    MEDIA_KIND_LABELS,
    MEDIA_STATUS_LABELS,
    MEDIA_STATUS_TONES,
    PLAN_ACTION_LABELS,
    PLAN_ACTION_TONES,
  } from '#lib/labels.ts';
  import { fileProcessAction } from '#lib/library/fileProcessAction.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { pairStreams } from '#lib/streams/pairStreams.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const id = $derived(Number(page.params.id));

  const detail = new Resource((signal) => api('GET /api/v1/media/:id', { params: { id }, signal }));
  const libraries = new Resource((signal) => api('GET /api/v1/libraries', { signal }));
  const history = new Resource((signal) =>
    api('GET /api/v1/history', { query: { mediaFileId: id, pageSize: 20, sortDir: 'desc' }, signal }),
  );
  const disc = new Resource((signal) => api('GET /api/v1/bdmv/discs/:id', { params: { id }, signal }));
  let busy = $state(false);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    void id;
    untrack(() => {
      detail.reset();
      history.reset();
      disc.reset();
      detail.load();
      history.load();
      libraries.load();
    });
  });

  $effect(() => {
    if (detail.data?.kind === 'bdmv' || detail.data?.kind === 'iso') untrack(() => disc.load());
  });

  function refreshSoon(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      detail.load({ silent: true });
      history.load({ silent: true });
    }, 800);
  }

  $effect(() =>
    live.on((event) => {
      if (event.name === 'media.updated' && event.payload.mediaFileId === id) refreshSoon();
      if ((event.name === 'job.finished' || event.name === 'job.started') && event.payload.job.mediaFileId === id) {
        refreshSoon();
      }
    }),
  );
  $effect(() => live.onReconnect(refreshSoon));
  $effect(() => () => clearTimeout(refreshTimer));

  const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

  async function reprobe(): Promise<void> {
    busy = true;
    const result = await attempt(() => api('POST /api/v1/media/:id/probe', { params: { id } }), 'File re-checked');
    if (result) detail.set(result);
    busy = false;
  }

  async function process(force: boolean): Promise<void> {
    busy = true;
    const result = await attempt(() => api('POST /api/v1/jobs', { body: { mediaFileIds: [id], force } }));
    if (result?.jobs.length) {
      const [job] = result.jobs;
      if (job) await goto(href(`/activity/jobs/${job.id}`));
    } else if (result) {
      toasts.show('warning', `Not queued: ${result.skipped[0]?.reason ?? 'the file does not need work'}`);
    }
    busy = false;
  }

  async function setIgnored(ignored: boolean): Promise<void> {
    busy = true;
    const summary = await attempt(
      () => api('PUT /api/v1/media/:id/ignore', { params: { id }, body: { ignored } }),
      ignored ? 'File ignored: scans will skip it' : 'File no longer ignored',
    );
    if (summary && detail.data) detail.set({ ...detail.data, ...summary });
    if (summary && !ignored) refreshSoon();
    busy = false;
  }
</script>

<Async resource={detail}>
  {#snippet children(file)}
    {@const library = libraries.data?.find((item) => item.id === file.libraryId)}
    <PageHeader title={fileName(file.path)} subtitle={file.path}>
      {#snippet actions()}
        <button onclick={reprobe} disabled={busy}><Icon name="refresh" size={16} /> Re-check</button>
        {@const action = fileProcessAction(file.status)}
        {#if action}
          <button class:primary={action.primary} onclick={() => process(action.force)} disabled={busy} title={action.title}>
            <Icon name="play" size={16} /> {action.label}
          </button>
        {/if}
        {#if file.status === 'ignored'}
          <button onclick={() => setIgnored(false)} disabled={busy}>Stop ignoring</button>
        {:else}
          <button onclick={() => setIgnored(true)} disabled={busy}>Ignore</button>
        {/if}
      {/snippet}
    </PageHeader>

    <section class="card">
      <dl class="kv">
        <dt>Status</dt>
        <dd>
          <Badge tone={MEDIA_STATUS_TONES[file.status]} label={MEDIA_STATUS_LABELS[file.status]} />
          {#if file.statusReason}<span class="muted">{file.statusReason}</span>{/if}
        </dd>
        <dt>Library</dt>
        <dd>
          <a href={href(`/library?libraryId=${file.libraryId}`)}>{library?.name ?? `Library ${file.libraryId}`}</a>
        </dd>
        <dt>Type</dt>
        <dd>{MEDIA_KIND_LABELS[file.kind]}{file.probe ? ` · ${file.probe.formatName}` : ''}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(file.sizeBytes)}</dd>
        <dt>Runtime</dt>
        <dd>{formatDuration(file.durationSec)}{file.probe ? ` · ${file.probe.chapterCount} chapters` : ''}</dd>
        <dt>Original language</dt>
        <dd>{file.originalLanguage ?? 'unknown'}</dd>
        {#if file.arr}
          <dt>{file.arr.kind === 'radarr' ? 'Radarr' : 'Sonarr'}</dt>
          <dd>{file.arr.kind === 'radarr' ? 'Movie' : 'Series'} #{file.arr.itemId} on instance #{file.arr.instanceId}</dd>
        {/if}
        <dt>Last checked</dt>
        <dd>{formatDateTime(file.probedAt)}</dd>
        {#if file.rulesKey}
          <dt>Rules key</dt>
          <dd class="mono">{file.rulesKey}</dd>
        {/if}
      </dl>
    </section>

    {#if file.plan}
      {@const plan = file.plan}
      <section class="card">
        <div class="card-header">
          <h2>Plan</h2>
          <Badge tone={PLAN_ACTION_TONES[plan.action]} label={PLAN_ACTION_LABELS[plan.action]} />
        </div>
        {#if plan.reasons.length > 0}
          <ul class="bullets">
            {#each plan.reasons as reason, index (index)}<li>{reason}</li>{/each}
          </ul>
        {:else}
          <p class="muted">Every stream already plays on the assigned profiles.</p>
        {/if}
        {#if plan.lostFeatures.length > 0}
          <div class="alert tone-warning lost">
            <strong>What will be lost</strong>
            <ul class="bullets">
              {#each plan.lostFeatures as feature, index (index)}<li>{feature}</li>{/each}
            </ul>
          </div>
        {/if}
        {#if plan.videoNotes.length > 0}
          <ul class="bullets muted">
            {#each plan.videoNotes as note, index (index)}<li>{note}</li>{/each}
          </ul>
        {/if}
        {#if plan.estimatedOutputBytes !== null}
          <p class="muted">Estimated output size: {formatBytes(plan.estimatedOutputBytes)}</p>
        {/if}
      </section>
    {/if}

    <section class="card">
      <h2>Streams</h2>
      {#if file.probe}
        <StreamCompare
          caption="Streams now and after conversion"
          beforeLabel="Now"
          afterLabel="After conversion"
          rows={pairStreams({ before: file.probe.streams, plan: file.plan?.action === 'skip' ? null : file.plan })}
        />
        {#if file.lastJobId}
          <p class="hint">
            The last job's actual before and after streams are on <a href={href(`/activity/jobs/${file.lastJobId}`)}
              >job #{file.lastJobId}</a
            >.
          </p>
        {/if}
      {:else}
        <p class="muted">Not probed yet. Use Re-check to read the streams.</p>
      {/if}
    </section>

    {#if file.kind !== 'file'}
      <section class="card">
        <h2>Blu-ray disc</h2>
        <Async resource={disc}>
          {#snippet children(info)}
            {#if info.encrypted}
              <div class="alert tone-danger">
                <p>This disc is encrypted ({info.encryptionMarkers.join(', ')}). Decrypt it with MakeMKV first.</p>
              </div>
            {/if}
            {#if info.needsDecision}
              <div class="alert tone-warning">
                <p>This disc waits for a decision. <a href={href('/library/decisions')}>Open decisions</a></p>
              </div>
            {/if}
            <p class="muted">Volume: {info.volumeLabel ?? 'unknown'} · main playlist: {info.mainPlaylist ?? 'not chosen'}</p>
            <div class="table-wrap">
              <table class="table">
                <caption class="sr-only">Playlists</caption>
                <thead>
                  <tr>
                    <th scope="col">Playlist</th>
                    <th scope="col">Role</th>
                    <th scope="col" class="num">Length</th>
                    <th scope="col" class="num hide-sm">Clips</th>
                    <th scope="col" class="num hide-sm">Chapters</th>
                    <th scope="col">Audio</th>
                    <th scope="col" class="hide-sm">Subtitles</th>
                  </tr>
                </thead>
                <tbody>
                  {#each info.playlists as playlist (playlist.playlist)}
                    <tr>
                      <td class="mono">{playlist.playlist}{playlist.duplicateOf ? ` (= ${playlist.duplicateOf})` : ''}</td>
                      <td>{playlist.role}</td>
                      <td class="num">{formatDuration(playlist.durationSec)}</td>
                      <td class="num hide-sm">{playlist.clips.length}</td>
                      <td class="num hide-sm">{playlist.chapterCount}</td>
                      <td class="mono">{playlist.audioLanguages.join(', ') || '-'}</td>
                      <td class="mono hide-sm">{playlist.subtitleLanguages.join(', ') || '-'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Async>
      </section>
    {/if}

    <section class="card">
      <h2>Jobs</h2>
      {#if file.jobs.length === 0}
        <p class="muted">No jobs for this file yet.</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Jobs for this file</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">State</th>
                <th scope="col">Step</th>
                <th scope="col" class="hide-sm">Created</th>
                <th scope="col" class="hide-sm">Finished</th>
              </tr>
            </thead>
            <tbody>
              {#each file.jobs as job (job.id)}
                <tr>
                  <td><a href={href(`/activity/jobs/${job.id}`)}>#{job.id} {job.type}</a></td>
                  <td><Badge tone={JOB_STATE_TONES[job.state]} label={JOB_STATE_LABELS[job.state]} title={job.error} /></td>
                  <td>{JOB_STEP_LABELS[job.step]}</td>
                  <td class="hide-sm nowrap">{formatDateTime(job.createdAt)}</td>
                  <td class="hide-sm nowrap">{formatDateTime(job.finishedAt)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="card">
      <h2>History</h2>
      <Async resource={history} isEmpty={(data) => data.items.length === 0} emptyText="No history for this file yet.">
        {#snippet children(data)}
          <ul class="list-plain events">
            {#each data.items as entry (entry.id)}
              <li>
                <Badge tone={HISTORY_EVENT_TONES[entry.event]} label={HISTORY_EVENT_LABELS[entry.event]} />
                <span>{entry.message}</span>
                <span class="muted nowrap">{formatDateTime(entry.createdAt)}</span>
              </li>
            {/each}
          </ul>
        {/snippet}
      </Async>
    </section>
  {/snippet}
</Async>

<style>
  .lost {
    margin-top: 0.75rem;
  }
  .events li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    align-items: baseline;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
  }
  .events li:last-child {
    border-bottom: none;
  }
</style>
