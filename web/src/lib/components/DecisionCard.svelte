<script lang="ts">
  import { api } from '#lib/api/client.ts';
  import { pendingDecisions } from '#lib/bdmv/pendingDecisions.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import { mainTitleChoice } from '#lib/bdmv/mainTitleChoice.ts';
  import Badge from '#lib/components/Badge.svelte';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { DECISION_KIND_LABELS } from '#lib/labels.ts';
  import { href } from '#lib/paths.ts';
  import type { ArrInstance, BdmvDecision, BdmvDecisionChoice, MovieMatchCandidate } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';

  let {
    decision,
    radarrInstances,
    onchange,
  }: { decision: BdmvDecision; radarrInstances: ArrInstance[]; onchange: () => void } = $props();

  const uid = $props.id();
  let busy = $state(false);
  let selectedPlaylists = $state<string[]>([]);
  let playlistRadio = $state('');
  let asEditions = $state(false);
  let editionNames = $state<Record<string, string>>({});
  let tmdbId = $state<number | null>(null);
  let searchTerm = $state('');
  let searchYear = $state('');
  let searchInstance = $state<number | null>(null);
  let searchResults = $state<MovieMatchCandidate[]>([]);
  let searchError = $state<string | null>(null);
  let formError = $state<string | null>(null);

  const pending = $derived(decision.state === 'pending');
  const instanceId = $derived(searchInstance ?? radarrInstances[0]?.id ?? null);
  const candidates = $derived([
    ...decision.movieCandidates,
    ...searchResults.filter((result) => !decision.movieCandidates.some((known) => known.tmdbId === result.tmdbId)),
  ]);

  async function resolve(choice: BdmvDecisionChoice, success: string): Promise<void> {
    busy = true;
    const result = await attempt(
      () => api('POST /api/v1/bdmv/decisions/:id/resolve', { params: { id: decision.id }, body: choice }),
      success,
    );
    busy = false;
    if (!result) return;
    pendingDecisions.load({ silent: true });
    onchange();
  }

  function resolveMainTitle(): void {
    const result = mainTitleChoice({
      playlists: asEditions ? selectedPlaylists : playlistRadio ? [playlistRadio] : [],
      asEditions,
      editionNames,
    });
    formError = result.ok ? null : result.reason;
    if (result.ok) resolve(result.choice, 'Main title chosen');
  }

  function resolveMovie(): void {
    if (tmdbId === null) {
      formError = 'Choose the movie.';
      return;
    }
    formError = null;
    resolve({ kind: 'movie_match', tmdbId }, 'Movie match saved');
  }

  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (instanceId === null || !searchTerm.trim()) return;
    searchError = null;
    try {
      searchResults = await api('GET /api/v1/arr/:id/lookup', {
        params: { id: instanceId },
        query: { term: searchTerm.trim(), year: searchYear ? Number(searchYear) : undefined },
      });
      if (searchResults.length === 0) searchError = 'Radarr found nothing for that search.';
    } catch (error) {
      searchError = errorMessage(error);
    }
  }

  async function dismiss(): Promise<void> {
    if (!confirm('Dismiss this decision? The disc stays as it is until the next scan asks again.')) return;
    busy = true;
    const result = await attempt(
      () => api('POST /api/v1/bdmv/decisions/:id/dismiss', { params: { id: decision.id } }),
      'Decision dismissed',
    );
    busy = false;
    if (!result) return;
    pendingDecisions.load({ silent: true });
    onchange();
  }

  function describeChoice(choice: BdmvDecisionChoice): string {
    switch (choice.kind) {
      case 'main_title':
        return choice.asEditions
          ? `Editions: ${choice.playlists.map((playlist) => `${choice.editionNames[playlist] ?? playlist} (${playlist})`).join(', ')}`
          : `Main title ${choice.playlists.join(', ')}`;
      case 'movie_match':
        return `TMDB ${choice.tmdbId}`;
      case 'delete_source':
        return choice.confirm ? 'Source deleted' : 'Source kept';
    }
  }
</script>

<article class="card decision" aria-labelledby="{uid}-title">
  <header class="card-header">
    <h2 id="{uid}-title">{DECISION_KIND_LABELS[decision.kind]}</h2>
    <Badge
      tone={decision.state === 'pending' ? 'warning' : decision.state === 'resolved' ? 'success' : 'neutral'}
      label={decision.state}
    />
  </header>
  <p class="break"><a href={href(`/library/${decision.mediaFileId}`)}>{decision.sourcePath}</a></p>
  <p>{decision.message}</p>
  <p class="hint">Asked {formatDateTime(decision.createdAt)}{decision.resolvedAt ? ` · answered ${formatDateTime(decision.resolvedAt)}` : ''}</p>

  {#if !pending}
    {#if decision.choice}<p><strong>Choice:</strong> {describeChoice(decision.choice)}</p>{/if}
  {:else if decision.kind === 'main_title'}
    <label class="check">
      <input type="checkbox" bind:checked={asEditions} />
      Export several playlists as Plex editions (Title (Year) &#123;edition-Name&#125;.mkv)
    </label>
    <div class="table-wrap">
      <table class="table">
        <caption class="sr-only">Playlist candidates</caption>
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">Choose</span></th>
            <th scope="col">Playlist</th>
            <th scope="col" class="num">Length</th>
            <th scope="col" class="num hide-sm">Chapters</th>
            <th scope="col">Audio</th>
            <th scope="col" class="hide-sm">Subtitles</th>
            {#if asEditions}<th scope="col">Edition name</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each decision.titleCandidates as candidate (candidate.playlist)}
            <tr>
              <td>
                {#if asEditions}
                  <input
                    type="checkbox"
                    aria-label="Use {candidate.playlist}"
                    value={candidate.playlist}
                    bind:group={selectedPlaylists}
                  />
                {:else}
                  <input
                    type="radio"
                    name="{uid}-playlist"
                    aria-label="Use {candidate.playlist}"
                    value={candidate.playlist}
                    bind:group={playlistRadio}
                  />
                {/if}
              </td>
              <td class="mono">{candidate.playlist}</td>
              <td class="num">{formatDuration(candidate.durationSec)}</td>
              <td class="num hide-sm">{candidate.chapterCount}</td>
              <td class="mono">{candidate.audioLanguages.join(', ') || '-'}</td>
              <td class="mono hide-sm">{candidate.subtitleLanguages.join(', ') || '-'}</td>
              {#if asEditions}
                <td>
                  <input
                    aria-label="Edition name for {candidate.playlist}"
                    placeholder="Extended"
                    disabled={!selectedPlaylists.includes(candidate.playlist)}
                    bind:value={editionNames[candidate.playlist]}
                  />
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if decision.kind === 'movie_match'}
    <fieldset>
      <legend class="sr-only">Movie</legend>
      {#each candidates as candidate (candidate.tmdbId)}
        <label class="check candidate">
          <input type="radio" name="{uid}-movie" value={candidate.tmdbId} bind:group={tmdbId} />
          <span>
            <strong>{candidate.title}</strong>{candidate.year ? ` (${candidate.year})` : ''}
            <span class="muted">TMDB {candidate.tmdbId} · match {Math.round(candidate.score * 100)}%{candidate.radarrMovieId
                ? ' · already in Radarr'
                : ''}</span>
          </span>
        </label>
      {:else}
        <p class="muted">Radarr had no match. Search below.</p>
      {/each}
    </fieldset>
    {#if radarrInstances.length > 0}
      <form class="search" onsubmit={search}>
        {#if radarrInstances.length > 1}
          <label class="sr-only" for="{uid}-instance">Radarr instance</label>
          <select id="{uid}-instance" value={instanceId} onchange={(event) => (searchInstance = Number(event.currentTarget.value))}>
            {#each radarrInstances as instance (instance.id)}<option value={instance.id}>{instance.name}</option>{/each}
          </select>
        {/if}
        <label class="sr-only" for="{uid}-term">Movie title</label>
        <input id="{uid}-term" bind:value={searchTerm} placeholder="Movie title" />
        <label class="sr-only" for="{uid}-year">Year</label>
        <input id="{uid}-year" class="year" bind:value={searchYear} placeholder="Year" inputmode="numeric" />
        <button type="submit" disabled={!searchTerm.trim()}>Search Radarr</button>
      </form>
      {#if searchError}<p class="muted">{searchError}</p>{/if}
    {:else}
      <p class="hint">Add a Radarr instance in <a href={href('/settings/connect')}>Settings > Connect</a> to search.</p>
    {/if}
  {:else}
    <p>The torrent met its seeding goal. Delete the original disc now that the MKV is in the library?</p>
  {/if}

  {#if formError}<p class="error" role="alert">{formError}</p>{/if}

  {#if pending}
    <div class="toolbar actions">
      {#if decision.kind === 'main_title'}
        <button class="primary" onclick={resolveMainTitle} disabled={busy}>Use selection</button>
      {:else if decision.kind === 'movie_match'}
        <button class="primary" onclick={resolveMovie} disabled={busy}>Use this movie</button>
      {:else}
        <button
          class="danger"
          disabled={busy}
          onclick={() =>
            confirm('Delete the source disc and its torrent files? This cannot be undone.') &&
            resolve({ kind: 'delete_source', confirm: true }, 'Source deleted')}>Delete source</button
        >
        <button onclick={() => resolve({ kind: 'delete_source', confirm: false }, 'Source kept')} disabled={busy}>
          Keep source
        </button>
      {/if}
      <button class="ghost" onclick={dismiss} disabled={busy}>Dismiss</button>
    </div>
  {/if}
</article>

<style>
  .decision h2 {
    font-size: 1rem;
  }
  .candidate {
    align-items: flex-start;
    display: flex;
  }
  .candidate input {
    margin-top: 0.2rem;
  }
  .search {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .search input {
    flex: 1;
    min-width: 10rem;
  }
  .search .year {
    flex: 0 0 5.5rem;
    min-width: 0;
  }
  .actions {
    margin-top: 0.75rem;
  }
  .error {
    color: var(--danger-fg);
  }
</style>
