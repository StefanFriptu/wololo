<script lang="ts">
  import { untrack } from 'svelte';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import { subscribeEvents } from '#lib/api/events.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { downloadBlob } from '#lib/download.ts';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { LOG_LEVEL_TONES } from '#lib/labels.ts';
  import { filterLogs, LOG_LEVELS } from '#lib/logs/filterLogs.ts';
  import { mergeLogs } from '#lib/logs/mergeLogs.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { LogEntry, LogFileInfo, LogLevel } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const MAX_ENTRIES = 1000;
  const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let tab = $state<'live' | 'files'>('live');
  let level = $state<LogLevel>('info');
  let moduleName = $state<string | null>(null);
  let search = $state('');
  let paused = $state(false);
  let entries = $state.raw<LogEntry[]>([]);
  let buffered = $state.raw<LogEntry[]>([]);
  let openFile = $state<{ name: string; text: string } | null>(null);

  const initial = new Resource((signal) => api('GET /api/v1/system/logs', { query: { limit: MAX_ENTRIES }, signal }));
  const files = new Resource((signal) => api('GET /api/v1/system/logs/files', { signal }));

  const modules = $derived([...new Set(entries.map((entry) => entry.module))].sort());
  const visible = $derived(filterLogs(entries, { level, module: moduleName, search }).reverse());

  $effect(() => {
    untrack(() => initial.load());
  });

  $effect(() => {
    if (initial.data) entries = mergeLogs(untrack(() => entries), initial.data, MAX_ENTRIES);
  });

  $effect(() => {
    if (tab === 'files') untrack(() => files.load());
  });

  $effect(() =>
    subscribeEvents(
      (event) => {
        if (event.name !== 'log.entry') return;
        if (paused) buffered = [...buffered, event.payload];
        else entries = mergeLogs(entries, [event.payload], MAX_ENTRIES);
      },
      { apiKey: auth.key, names: ['log.entry'], onOpen: (reconnected) => reconnected && initial.load({ silent: true }) },
    ),
  );

  function resume(): void {
    entries = mergeLogs(entries, buffered, MAX_ENTRIES);
    buffered = [];
    paused = false;
  }

  async function view(file: LogFileInfo): Promise<void> {
    try {
      openFile = { name: file.name, text: await api('GET /api/v1/system/logs/files/:name', { params: { name: file.name } }) };
    } catch (error) {
      toasts.error(error);
    }
  }

  async function download(name: string): Promise<void> {
    try {
      const text = await api('GET /api/v1/system/logs/files/:name', { params: { name } });
      downloadBlob(new Blob([text], { type: 'text/plain' }), name);
    } catch (error) {
      toasts.error(error);
    }
  }
</script>

<PageHeader title="Logs">
  {#snippet actions()}
    <div class="toolbar" role="group" aria-label="View">
      <button class="small" aria-pressed={tab === 'live'} onclick={() => (tab = 'live')}>Live</button>
      <button class="small" aria-pressed={tab === 'files'} onclick={() => (tab = 'files')}>Files</button>
    </div>
  {/snippet}
</PageHeader>

{#if tab === 'live'}
  <section class="card">
    <form class="filters" role="search" onsubmit={(event) => event.preventDefault()}>
      <label>
        <span>Level</span>
        <select bind:value={level}>
          {#each LOG_LEVELS as option (option)}<option value={option}>{option} and up</option>{/each}
        </select>
      </label>
      <label>
        <span>Module</span>
        <select value={moduleName ?? ''} onchange={(event) => (moduleName = event.currentTarget.value || null)}>
          <option value="">All modules</option>
          {#each modules as name (name)}<option value={name}>{name}</option>{/each}
        </select>
      </label>
      <label class="grow">
        <span>Search</span>
        <input type="search" bind:value={search} placeholder="Message contains…" />
      </label>
      {#if paused}
        <button type="button" onclick={resume}><Icon name="play" size={14} /> Resume ({buffered.length} new)</button>
      {:else}
        <button type="button" onclick={() => (paused = true)}><Icon name="pause" size={14} /> Pause</button>
      {/if}
    </form>

    {#if initial.error && entries.length === 0}
      <p class="alert tone-danger" role="alert">{errorMessage(initial.error)}</p>
    {:else if initial.loading && entries.length === 0}
      <p class="muted" role="status">Loading…</p>
    {:else if visible.length === 0}
      <p class="muted empty">No log entries match.</p>
    {:else}
      <div class="table-wrap">
        <table class="table logs">
          <caption class="sr-only">Log entries, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Level</th>
              <th scope="col" class="hide-sm">Module</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as entry (entry.id)}
              <tr>
                <td class="nowrap mono" title={formatDateTime(entry.time)}>{TIME.format(Date.parse(entry.time))}</td>
                <td><Badge tone={LOG_LEVEL_TONES[entry.level]} label={entry.level} /></td>
                <td class="hide-sm mono">{entry.module}</td>
                <td class="message">
                  {entry.message}
                  {#if entry.data && Object.keys(entry.data).length > 0}
                    <details>
                      <summary class="muted">Details</summary>
                      <pre class="log">{JSON.stringify(entry.data, null, 2)}</pre>
                    </details>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{:else}
  <section class="card">
    <Async resource={files} isEmpty={(list) => list.length === 0} emptyText="No log files yet.">
      {#snippet children(list)}
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Log files</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col" class="num">Size</th>
                <th scope="col" class="hide-sm">Modified</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each list as file (file.name)}
                <tr>
                  <td class="mono">{file.name}</td>
                  <td class="num">{formatBytes(file.sizeBytes)}</td>
                  <td class="hide-sm nowrap">{formatDateTime(file.modifiedAt)}</td>
                  <td class="actions">
                    <button class="small" onclick={() => view(file)}>View</button>
                    <button class="small" onclick={() => download(file.name)} aria-label="Download {file.name}"><Icon name="download" size={14} /></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/snippet}
    </Async>
  </section>
  {#if openFile}
    <section class="card">
      <div class="card-header">
        <h2 class="mono">{openFile.name}</h2>
        <button class="small" onclick={() => (openFile = null)}><Icon name="close" size={14} /> Close</button>
      </div>
      <pre class="log">{openFile.text}</pre>
    </section>
  {/if}
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: flex-end;
    margin-bottom: 1rem;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }
  .filters select,
  .filters input {
    color: var(--text);
  }
  .grow {
    flex: 1;
    min-width: 10rem;
  }
  .logs td {
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
  }
  .message {
    overflow-wrap: anywhere;
    min-width: 14rem;
  }
  .empty {
    text-align: center;
    padding: 1rem 0;
  }
  [aria-pressed='true'] {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
</style>
