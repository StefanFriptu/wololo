<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import { clock } from '#lib/clock.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import ConvertTargetModal from '#lib/components/ConvertTargetModal.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import Pagination from '#lib/components/Pagination.svelte';
  import ScanPanel from '#lib/components/ScanPanel.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { formatRelativeTime } from '#lib/format/formatRelativeTime.ts';
  import { MEDIA_KIND_LABELS, MEDIA_STATUS_LABELS, MEDIA_STATUS_TONES } from '#lib/labels.ts';
  import type { MediaFilters } from '#lib/library/MediaFilters.ts';
  import { PAGE_SIZES } from '#lib/library/pageSizes.ts';
  import { parseMediaFilters } from '#lib/library/parseMediaFilters.ts';
  import { needsWorkScope } from '#lib/library/needsWorkScope.ts';
  import { syncSearchText } from '#lib/library/syncSearchText.svelte.ts';
  import { serializeMediaFilters } from '#lib/library/serializeMediaFilters.ts';
  import { pageInRange } from '#lib/pageInRange.ts';
  import { convertTargets, type ConvertTarget } from '#lib/profiles/convertTargets.ts';
  import { onlyDiscs } from '#lib/profiles/onlyDiscs.ts';
  import { profileChip } from '#lib/profiles/profileChip.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { MEDIA_FILE_STATUSES, type MediaSortKey } from '#lib/shared.ts';
  import { MEDIA_KIND_FILTER_LABELS, type MediaKindFilter } from '#lib/library/mediaKindFilterLabels.ts';
  import { attempt } from '#lib/attempt.ts';

  const REFRESH_DEBOUNCE_MS = 1500;

  const filters = $derived(parseMediaFilters(page.url.searchParams));
  const filterKey = $derived(serializeMediaFilters(filters));

  const libraries = new Resource((signal) => api('GET /api/v1/libraries', { signal }));
  const profiles = new Resource((signal) => api('GET /api/v1/profiles', { signal }));
  const codecs = new Resource((signal) => api('GET /api/v1/profiles/codecs', { signal }));
  const stats = new Resource((signal) =>
    api('GET /api/v1/media/stats', { query: { libraryId: filters.libraryId }, signal }),
  );
  const media = new Resource((signal) => api('GET /api/v1/media', { query: filters, signal }));

  const selected = new SvelteSet<number>();
  let searchText = $state(parseMediaFilters(page.url.searchParams).search ?? '');
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    untrack(() => {
      libraries.load();
      profiles.load();
      codecs.load();
    });
  });

  $effect(() => {
    void filterKey;
    untrack(() => {
      selected.clear();
      media.load({ silent: media.data !== undefined });
    });
  });

  $effect(() => {
    const target = media.data ? pageInRange(media.data) : null;
    if (target !== null) untrack(() => update({ page: target }));
  });

  $effect(() => {
    void filters.libraryId;
    untrack(() => stats.load({ silent: stats.data !== undefined }));
  });

  function refreshSoon(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      media.load({ silent: true });
      stats.load({ silent: true });
    }, REFRESH_DEBOUNCE_MS);
  }

  $effect(() =>
    live.on((event) => {
      if (event.name === 'media.updated') {
        const current = media.data;
        const { mediaFileId, status } = event.payload;
        if (current?.items.some((item) => item.id === mediaFileId)) {
          media.set({
            ...current,
            items: current.items.map((item) => (item.id === mediaFileId ? { ...item, status } : item)),
          });
        }
        refreshSoon();
      }
      if (event.name === 'media.removed') refreshSoon();
    }),
  );

  $effect(() => live.onReconnect(refreshSoon));
  $effect(() => () => clearTimeout(refreshTimer));

  const searchSync = syncSearchText({
    urlSearch: () => filters.search,
    read: () => searchText,
    write: (text) => (searchText = text),
  });

  $effect(() => {
    const text = searchText.trim();
    if (text === (untrack(() => filters.search) ?? '')) return;
    const timer = setTimeout(() => {
      searchSync.markPushed(text);
      update({ search: text || undefined });
    }, 350);
    return () => clearTimeout(timer);
  });

  function update(patch: Partial<MediaFilters>): void {
    const next = { ...filters, page: 1, ...patch };
    goto(href(`/library${serializeMediaFilters(next)}`), { replace: true, reset: false });
  }

  function sortBy(key: MediaSortKey): void {
    const sortDir = filters.sortKey === key && filters.sortDir === 'asc' ? 'desc' : 'asc';
    update({ sortKey: key, sortDir });
  }

  function ariaSort(key: MediaSortKey): 'ascending' | 'descending' | 'none' {
    if (filters.sortKey !== key) return 'none';
    return filters.sortDir === 'asc' ? 'ascending' : 'descending';
  }

  function numberOrUndefined(value: string): number | undefined {
    return value === '' ? undefined : Number(value);
  }

  const KIND_FILTERS = Object.keys(MEDIA_KIND_FILTER_LABELS) as MediaKindFilter[];

  const hasFilters = $derived(
    [filters.status, filters.kind, filters.libraryId, filters.profileId, filters.codec, filters.failingCodec, filters.search].some(
      (value) => value !== undefined,
    ),
  );

  const bulkScope = $derived(
    needsWorkScope({
      filters,
      libraryName: libraries.data?.find((item) => item.id === filters.libraryId)?.name ?? null,
      profileName: profiles.data?.find((item) => item.id === filters.profileId)?.name ?? null,
      listedTotal: media.data?.total ?? null,
    }),
  );

  const profileNames = $derived(new Map((profiles.data ?? []).map((profile) => [profile.id, profile.name])));
  const profileName = (id: number): string => profileNames.get(id) ?? `#${id}`;

  let convertOpen = $state(false);
  let convert = $state<{ question: string; targets: ConvertTarget[]; run: (profileId: number | undefined) => Promise<void> }>({
    question: '',
    targets: [],
    run: async () => {},
  });

  function targetsFor(libraryIds: readonly number[]): ConvertTarget[] {
    const profileIds = (libraries.data ?? [])
      .filter((library) => libraryIds.includes(library.id))
      .flatMap((library) => library.profileIds);
    return convertTargets(profileIds, profiles.data ?? []);
  }

  const queuedMessage = (result: { jobs: unknown[]; skipped: { reason: string }[] }): string =>
    `Queued ${result.jobs.length} job(s)${result.skipped.length ? `, skipped ${result.skipped.length}: ${result.skipped[0]?.reason}` : ''}`;

  function processNeedsWork(): void {
    const scope = bulkScope;
    const libraryIds = filters.libraryId === undefined ? (libraries.data ?? []).map((library) => library.id) : [filters.libraryId];
    convert = {
      question: scope.question,
      targets: onlyDiscs(filters.kind?.split(',') ?? []) ? [] : targetsFor(libraryIds),
      run: async (profileId) => {
        await attempt(() => api('POST /api/v1/jobs', { body: { filter: scope.filter, profileId } }), queuedMessage);
      },
    };
    convertOpen = true;
  }

  async function enqueueSelected(items: { id: number; kind: string }[], profileId: number | undefined): Promise<void> {
    const discs = items.filter((item) => onlyDiscs([item.kind])).map((item) => item.id);
    const files = items.filter((item) => !onlyDiscs([item.kind])).map((item) => item.id);
    const batches = profileId === undefined ? [{ ids: [...files, ...discs] }] : [{ ids: files, profileId }, { ids: discs }];
    const result = await attempt(async () => {
      const responses = await Promise.all(
        batches
          .filter((batch) => batch.ids.length > 0)
          .map((batch) => api('POST /api/v1/jobs', { body: { mediaFileIds: batch.ids, profileId: batch.profileId } })),
      );
      return { jobs: responses.flatMap((response) => response.jobs), skipped: responses.flatMap((response) => response.skipped) };
    }, queuedMessage);
    if (result) selected.clear();
  }

  async function processSelected(): Promise<void> {
    const items = (media.data?.items ?? []).filter((item) => selected.has(item.id));
    const targets = onlyDiscs(items.map((item) => item.kind)) ? [] : targetsFor(items.map((item) => item.libraryId));
    if (targets.length === 0) return enqueueSelected(items, undefined);
    convert = {
      question: `Queue ${items.length} selected file(s)?`,
      targets,
      run: (profileId) => enqueueSelected(items, profileId),
    };
    convertOpen = true;
  }

  function toggleAll(ids: number[], checked: boolean): void {
    for (const id of ids) {
      if (checked) selected.add(id);
      else selected.delete(id);
    }
  }
</script>

<PageHeader title="Library">
  {#snippet actions()}
    {#if selected.size > 0}
      <button onclick={processSelected}><Icon name="play" size={16} /> Process {selected.size} selected</button>
    {/if}
    <button class="primary" onclick={processNeedsWork}>
      <Icon name="play" size={16} /> Process needs-work
    </button>
  {/snippet}
</PageHeader>

<ConvertTargetModal bind:open={convertOpen} question={convert.question} targets={convert.targets} onconfirm={convert.run} />

<ScanPanel libraryId={filters.libraryId} onfinished={refreshSoon} />

{#if stats.data}
  {@const counts = stats.data}
  <div class="status-filter" role="group" aria-label="Filter by status">
    <button class="small" aria-pressed={filters.status === undefined} onclick={() => update({ status: undefined })}>
      All <span class="count">{counts.total}</span>
    </button>
    {#each MEDIA_FILE_STATUSES as status (status)}
      <button class="small" aria-pressed={filters.status === status} onclick={() => update({ status })}>
        <Badge tone={MEDIA_STATUS_TONES[status]} label={MEDIA_STATUS_LABELS[status]} />
        <span class="count">{counts.byStatus[status] ?? 0}</span>
      </button>
    {/each}
    <span class="muted total">{formatBytes(counts.totalBytes)}</span>
  </div>
{/if}

<section class="card">
  <form class="filters" role="search" onsubmit={(event) => event.preventDefault()}>
    <label>
      <span>Search</span>
      <input type="search" bind:value={searchText} placeholder="Path contains…" />
    </label>
    <label>
      <span>Library</span>
      <select
        value={filters.libraryId ?? ''}
        onchange={(event) => update({ libraryId: numberOrUndefined(event.currentTarget.value) })}
      >
        <option value="">All libraries</option>
        {#each libraries.data ?? [] as library (library.id)}
          <option value={library.id}>{library.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Profile</span>
      <select
        value={filters.profileId ?? ''}
        onchange={(event) => update({ profileId: numberOrUndefined(event.currentTarget.value) })}
      >
        <option value="">Any profile</option>
        {#each profiles.data ?? [] as profile (profile.id)}
          <option value={profile.id}>{profile.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Codec</span>
      <select value={filters.codec ?? ''} onchange={(event) => update({ codec: event.currentTarget.value || undefined })}>
        <option value="">Any codec</option>
        {#if codecs.data}
          <optgroup label="Audio">
            {#each codecs.data.audio as codec (codec.codec)}<option value={codec.codec}>{codec.label}</option>{/each}
          </optgroup>
          <optgroup label="Video">
            {#each codecs.data.video as codec (codec.codec)}<option value={codec.codec}>{codec.label}</option>{/each}
          </optgroup>
          <optgroup label="Subtitles">
            {#each codecs.data.subtitle as codec (codec.codec)}<option value={codec.codec}>{codec.label}</option>{/each}
          </optgroup>
        {:else if filters.codec}
          <option value={filters.codec}>{filters.codec}</option>
        {/if}
      </select>
    </label>
    <label>
      <span>Failing codec</span>
      <select
        value={filters.failingCodec ?? ''}
        onchange={(event) => update({ failingCodec: event.currentTarget.value || undefined })}
      >
        <option value="">Any</option>
        {#each stats.data?.byFailingCodec ?? [] as row (row.codec)}
          <option value={row.codec}>{row.codec} ({row.count})</option>
        {/each}
        {#if filters.failingCodec && !stats.data?.byFailingCodec.some((row) => row.codec === filters.failingCodec)}
          <option value={filters.failingCodec}>{filters.failingCodec}</option>
        {/if}
      </select>
    </label>
    <label>
      <span>Type</span>
      <select
        value={filters.kind ?? ''}
        onchange={(event) =>
          update({ kind: KIND_FILTERS.find((kind) => kind === event.currentTarget.value) })}
      >
        <option value="">Any type</option>
        {#each KIND_FILTERS as kind (kind)}<option value={kind}>{MEDIA_KIND_FILTER_LABELS[kind]}</option>{/each}
      </select>
    </label>
    {#if hasFilters}
      <button
        type="button"
        class="small clear"
        onclick={() => {
          searchText = '';
          goto(href('/library'), { replace: true, reset: false });
        }}>Clear filters</button
      >
    {/if}
  </form>

  {#if libraries.data && libraries.data.length === 0}
    <div class="empty">
      <p><strong>No libraries yet.</strong></p>
      <p class="muted">Add your movie and series folders in <a href={href('/settings/media')}>Settings > Media</a>, then run a scan.</p>
    </div>
  {:else}
    <Async resource={media} isEmpty={(data) => data.items.length === 0}>
      {#snippet empty()}
        <div class="empty">
          {#if hasFilters}
            <p class="muted">No files match these filters.</p>
          {:else}
            <p class="muted">No files found yet. Run a scan to find media in your libraries.</p>
          {/if}
        </div>
      {/snippet}
      {#snippet children(data)}
        {@const ids = data.items.map((item) => item.id)}
        <div class="table-wrap" aria-busy={media.loading}>
          <table class="table">
            <caption class="sr-only">Media files</caption>
            <thead>
              <tr>
                <th scope="col" class="select">
                  <input
                    type="checkbox"
                    aria-label="Select all files on this page"
                    checked={ids.length > 0 && ids.every((id) => selected.has(id))}
                    onchange={(event) => toggleAll(ids, event.currentTarget.checked)}
                  />
                </th>
                {#snippet sortable(key: MediaSortKey, label: string, className = '')}
                  <th scope="col" class={className} aria-sort={ariaSort(key)}>
                    <button class="sort" onclick={() => sortBy(key)}>
                      {label}
                      <span aria-hidden="true">{filters.sortKey === key ? (filters.sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                {/snippet}
                {@render sortable('path', 'File')}
                {@render sortable('status', 'Status')}
                <th scope="col" class="hide-sm">Video</th>
                <th scope="col">Audio</th>
                <th scope="col">Players</th>
                {@render sortable('size', 'Size', 'num')}
                {@render sortable('duration', 'Runtime', 'num hide-sm')}
                {@render sortable('updatedAt', 'Updated', 'hide-sm')}
              </tr>
            </thead>
            <tbody>
              {#each data.items as item (item.id)}
                <tr>
                  <td class="select">
                    <input
                      type="checkbox"
                      aria-label="Select {item.relativePath}"
                      checked={selected.has(item.id)}
                      onchange={(event) =>
                        event.currentTarget.checked ? selected.add(item.id) : selected.delete(item.id)}
                    />
                  </td>
                  <td class="file">
                    <a href={href(`/library/${item.id}`)} title={item.path}>{item.relativePath}</a>
                    {#if item.kind !== 'file'}<span class="badge tone-info">{MEDIA_KIND_LABELS[item.kind]}</span>{/if}
                  </td>
                  <td>
                    <Badge
                      tone={MEDIA_STATUS_TONES[item.status]}
                      label={MEDIA_STATUS_LABELS[item.status]}
                      title={item.statusReason}
                    />
                  </td>
                  <td class="hide-sm mono">{item.videoCodec ?? '-'}</td>
                  <td>
                    <span class="chips">
                      {#each item.audioCodecs as codec, index (index)}
                        <span class="chip" class:failing={item.failingCodecs.includes(codec)}>{codec}</span>
                      {/each}
                    </span>
                  </td>
                  <td>
                    {#if item.profileResults === null}
                      <span class="muted" title="Not checked against the players yet">—</span>
                    {:else if item.profileResults.length === 0}
                      <span class="muted">No profile</span>
                    {:else}
                      <span class="chips">
                        {#each item.profileResults as result (result.profileId)}
                          {@const chip = profileChip(result, profileName(result.profileId))}
                          <Badge tone={chip.tone} label={chip.label} />
                        {/each}
                      </span>
                    {/if}
                  </td>
                  <td class="num">{formatBytes(item.sizeBytes)}</td>
                  <td class="num hide-sm">{formatDuration(item.durationSec)}</td>
                  <td class="hide-sm nowrap" title={item.updatedAt}>{formatRelativeTime(item.updatedAt, clock.now)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="footer">
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onpage={(next) => update({ page: next })} />
          <label class="page-size">
            <span>Per page</span>
            <select value={filters.pageSize} onchange={(event) => update({ pageSize: Number(event.currentTarget.value) })}>
              {#each PAGE_SIZES as size (size)}<option value={size}>{size}</option>{/each}
            </select>
          </label>
        </div>
      {/snippet}
    </Async>
  {/if}
</section>

<style>
  .status-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 1rem;
  }
  .status-filter button[aria-pressed='true'] {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .total {
    margin-left: auto;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.6rem;
    align-items: end;
    margin-bottom: 1rem;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }
  .filters input,
  .filters select {
    width: 100%;
    color: var(--text);
  }
  .clear {
    justify-self: start;
  }
  th.select,
  td.select {
    width: 2rem;
  }
  .sort {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
  }
  .file {
    min-width: 14rem;
    overflow-wrap: anywhere;
  }
  .file .badge {
    margin-left: 0.4rem;
  }
  .chip.failing {
    background: var(--warning-bg);
    color: var(--warning-fg);
    border-color: currentColor;
  }
  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .footer :global(.pagination) {
    flex: 1;
  }
  .page-size {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9em;
  }
  .empty {
    text-align: center;
    padding: 1.5rem 0;
  }
</style>
