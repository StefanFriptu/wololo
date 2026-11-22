<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import { clock } from '#lib/clock.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import Pagination from '#lib/components/Pagination.svelte';
  import { clampPage } from '#lib/clampPage.svelte.ts';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { fileName } from '#lib/format/fileName.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatRelativeTime } from '#lib/format/formatRelativeTime.ts';
  import { HISTORY_EVENT_LABELS, HISTORY_EVENT_TONES } from '#lib/labels.ts';
  import { href } from '#lib/paths.ts';
  import { positiveIntParam, queryString } from '#lib/queryParams.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { HistoryEventType } from '#lib/shared.ts';

  const PAGE_SIZE = 50;
  const REFRESH_DEBOUNCE_MS = 1000;
  const EVENTS = Object.keys(HISTORY_EVENT_LABELS) as HistoryEventType[];

  const event = $derived(EVENTS.find((value) => value === page.url.searchParams.get('event')));
  const pageNumber = $derived(positiveIntParam(page.url.searchParams.get('page')) ?? 1);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const history = new Resource((signal) =>
    api('GET /api/v1/history', { query: { event, page: pageNumber, pageSize: PAGE_SIZE, sortDir: 'desc' }, signal }),
  );

  $effect(() => {
    void event;
    void pageNumber;
    untrack(() => history.load({ silent: history.data !== undefined }));
  });

  clampPage(
    () => history.data,
    (target) => update({ page: target }),
  );

  function update(patch: { event?: HistoryEventType; page?: number }): void {
    const next = { event, page: 1, ...patch };
    const query = queryString({ event: next.event, page: next.page > 1 ? next.page : undefined });
    goto(href(`/activity/history${query}`), { replace: true, reset: false });
  }

  function refreshSoon(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => history.load({ silent: true }), REFRESH_DEBOUNCE_MS);
  }

  $effect(() =>
    live.on((message) => {
      if (pageNumber !== 1) return;
      if (message.name === 'job.finished' || message.name === 'job.queued') refreshSoon();
    }),
  );
  $effect(() => () => clearTimeout(refreshTimer));
  $effect(() => live.onReconnect(() => history.load({ silent: true })));
</script>

<PageHeader title="History">
  {#snippet actions()}
    <label class="filter">
      <span class="sr-only">Event</span>
      <select
        value={event ?? ''}
        onchange={(change) => update({ event: EVENTS.find((value) => value === change.currentTarget.value) })}
      >
        <option value="">All events</option>
        {#each EVENTS as value (value)}<option {value}>{HISTORY_EVENT_LABELS[value]}</option>{/each}
      </select>
    </label>
    <button onclick={() => history.load()} disabled={history.loading}><Icon name="refresh" size={16} /> Refresh</button>
  {/snippet}
</PageHeader>

<section class="card">
  <Async resource={history} isEmpty={(data) => data.items.length === 0} emptyText="No history yet.">
    {#snippet children(data)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">History</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">File</th>
              <th scope="col">Details</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as entry (entry.id)}
              {@const info = entry.data}
              <tr>
                <td><Badge tone={HISTORY_EVENT_TONES[entry.event]} label={HISTORY_EVENT_LABELS[entry.event]} /></td>
                <td class="file">
                  {#if entry.mediaFileId !== null}
                    <a href={href(`/library/${entry.mediaFileId}`)} title={entry.path}>{fileName(entry.path)}</a>
                  {:else}
                    <span title={entry.path}>{fileName(entry.path)}</span>
                  {/if}
                  {#if entry.jobId !== null}
                    <a class="muted small" href={href(`/activity/jobs/${entry.jobId}`)}>job #{entry.jobId}</a>
                  {/if}
                </td>
                <td class="details">
                  <div>{entry.message}</div>
                  {#if info?.lostFeatures?.length}
                    <div class="chips">
                      {#each info.lostFeatures as feature, index (index)}<Badge tone="warning" label={feature} />{/each}
                    </div>
                  {/if}
                  {#if info?.bytesBefore != null && info.bytesAfter != null}
                    <div class="muted small">{formatBytes(info.bytesBefore)} → {formatBytes(info.bytesAfter)}</div>
                  {/if}
                  {#if info?.retagged?.length}
                    <div class="muted small">Language tags filled: {info.retagged.join(', ')}</div>
                  {/if}
                  {#if info?.outputPath}<div class="muted small break">{info.outputPath}</div>{/if}
                  {#if info?.error}<div class="error small">{info.error}</div>{/if}
                </td>
                <td class="nowrap" title={formatDateTime(entry.createdAt)}>{formatRelativeTime(entry.createdAt, clock.now)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onpage={(next) => update({ page: next })} />
    {/snippet}
  </Async>
</section>

<style>
  .filter select {
    min-width: 10rem;
  }
  .file {
    min-width: 12rem;
    overflow-wrap: anywhere;
  }
  .file a + a {
    display: block;
  }
  .details {
    min-width: 14rem;
  }
  .details .chips {
    margin-top: 0.25rem;
  }
  .small {
    font-size: 0.85em;
  }
  .error {
    color: var(--danger-fg);
  }
</style>
