<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import ScanPanel from '#lib/components/ScanPanel.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatEstimate } from '#lib/format/formatEstimate.ts';
  import { dryRunGroupLinks } from '#lib/library/dryRunGroupLinks.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { attempt } from '#lib/attempt.ts';

  let libraryId = $state<number | undefined>(undefined);
  let profileId = $state<number | undefined>(undefined);

  const libraries = new Resource((signal) => api('GET /api/v1/libraries', { signal }));
  const profiles = new Resource((signal) => api('GET /api/v1/profiles', { signal }));
  const report = new Resource((signal) => api('GET /api/v1/dryrun', { query: { libraryId, profileId }, signal }));

  $effect(() => {
    untrack(() => {
      libraries.load();
      profiles.load();
    });
  });

  $effect(() => {
    void libraryId;
    void profileId;
    untrack(() => report.load({ silent: report.data !== undefined }));
  });

  $effect(() =>
    live.on((event) => {
      if (event.name === 'settings.changed' && event.payload.sections.includes('processing')) {
        report.load({ silent: true });
      }
    }),
  );
  $effect(() => live.onReconnect(() => report.load({ silent: true })));

  const toNumber = (value: string): number | undefined => (value === '' ? undefined : Number(value));

  async function processAll(): Promise<void> {
    const library = libraries.data?.find((item) => item.id === libraryId);
    const files = report.data?.totals.needsWork;
    const count = files === undefined ? 'every file' : `all ${files} file(s)`;
    if (!confirm(`Queue ${count} that need work ${library ? `in ${library.name}` : 'in every library'}?`)) return;
    await attempt(
      () => api('POST /api/v1/jobs', { body: { filter: { libraryId, status: 'needs_work' } } }),
      (result) => `Queued ${result.jobs.length} job(s)${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`,
    );
  }
</script>

<PageHeader title="Dry run" subtitle="What processing would do, per codec and profile. Nothing is written.">
  {#snippet actions()}
    <button onclick={() => report.load()} disabled={report.loading}><Icon name="refresh" size={16} /> Refresh</button>
  {/snippet}
</PageHeader>

<div class="toolbar selectors">
  <label>
    <span>Library</span>
    <select value={libraryId ?? ''} onchange={(event) => (libraryId = toNumber(event.currentTarget.value))}>
      <option value="">All libraries</option>
      {#each libraries.data ?? [] as library (library.id)}<option value={library.id}>{library.name}</option>{/each}
    </select>
  </label>
  <label>
    <span>Profile</span>
    <select value={profileId ?? ''} onchange={(event) => (profileId = toNumber(event.currentTarget.value))}>
      <option value="">Every assigned profile</option>
      {#each profiles.data ?? [] as profile (profile.id)}<option value={profile.id}>{profile.name}</option>{/each}
    </select>
  </label>
</div>

<ScanPanel {libraryId} onfinished={() => report.load({ silent: true })} />

<Async resource={report}>
  {#snippet children(data)}
    {#if data.processingEnabled}
      <div class="alert tone-info">
        <p>Processing is on: files that need work are converted as they are found.</p>
        {#if data.totals.needsWork > 0}
          <button class="primary small" onclick={processAll}><Icon name="play" size={14} /> Process all needs-work</button>
        {/if}
      </div>
    {:else}
      <div class="alert tone-warning">
        <p>
          <strong>Dry-run mode.</strong> Wololo only probes and reports. When this report looks right, turn on processing in
          <a href={href('/settings/media')}>Settings > Media</a>, then start the backlog with "Process all needs-work".
        </p>
      </div>
    {/if}

    <div class="stats">
      <div class="stat"><span class="value">{data.totals.files}</span><span class="label">Files</span></div>
      <div class="stat"><span class="value">{data.totals.compatible}</span><span class="label">Compatible</span></div>
      <div class="stat"><span class="value">{data.totals.needsWork}</span><span class="label">Need work</span></div>
      <div class="stat"><span class="value">{data.totals.blocked}</span><span class="label">Blocked</span></div>
      <div class="stat"><span class="value">{data.totals.failed}</span><span class="label">Failed</span></div>
      <div class="stat"><span class="value">{data.totals.pending}</span><span class="label">Not probed</span></div>
      <div class="stat"><span class="value">{data.totals.ignored}</span><span class="label">Ignored</span></div>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="value">{formatEstimate(data.estimatedSeconds)}</span><span class="label">Estimated processing time</span>
      </div>
      <div class="stat">
        <span class="value">{formatBytes(data.estimatedExtraBytes)}</span><span class="label">Peak extra disk space</span>
      </div>
      <div class="stat">
        <span class="value">{formatBytes(data.estimatedRecycleBytes)}</span><span class="label">Held in the recycle bin</span>
      </div>
    </div>

    <section class="card">
      <h2>By failing codec</h2>
      {#if data.groups.length === 0}
        <p class="muted">No file needs work{data.totals.pending > 0 ? ' so far; some files are not probed yet' : ''}.</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Files that need work, grouped by failing codec</caption>
            <thead>
              <tr>
                <th scope="col">Codec</th>
                <th scope="col" class="num">Files</th>
                <th scope="col" class="num hide-sm">Runtime</th>
                <th scope="col" class="num">Size</th>
                <th scope="col" class="num">Est. time</th>
                <th scope="col" class="num hide-sm">Est. output</th>
                <th scope="col" class="hide-sm">Examples</th>
              </tr>
            </thead>
            <tbody>
              {#each data.groups as group (group.codec)}
                <tr>
                  <td>
                    {#if group.codec === 'bdmv'}<span class="mono">bdmv</span>:{/if}
                    {#each dryRunGroupLinks(group.codec, libraryId) as link, index (link.query)}
                      {#if index > 0}·{/if}
                      <a class="mono" href={href(`/library${link.query}`)}>{link.label}</a>
                    {/each}
                  </td>
                  <td class="num">{group.files}</td>
                  <td class="num hide-sm">{formatEstimate(group.durationSec)}</td>
                  <td class="num">{formatBytes(group.sizeBytes)}</td>
                  <td class="num">{formatEstimate(group.estimatedSeconds)}</td>
                  <td class="num hide-sm">{formatBytes(group.estimatedOutputBytes)}</td>
                  <td class="hide-sm samples">
                    {#if group.samplePaths.length > 0}
                      <details>
                        <summary>{group.samplePaths.length} example(s)</summary>
                        <ul class="list-plain">
                          {#each group.samplePaths as path (path)}<li class="break muted">{path}</li>{/each}
                        </ul>
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

    <section class="card">
      <h2>By profile</h2>
      <p class="hint">Each profile on its own. Jobs apply the strictest combination of a library's profiles, as above.</p>
      {#if data.byProfile.length === 0}
        <p class="muted">No profile is assigned to a library yet.</p>
      {:else}
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Files per profile</caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col" class="num">Files</th>
                <th scope="col" class="num">Failing</th>
                <th scope="col" class="num hide-sm">Runtime</th>
                <th scope="col" class="num">Est. time</th>
                <th scope="col" class="num hide-sm">Est. output</th>
              </tr>
            </thead>
            <tbody>
              {#each data.byProfile as row (row.profileId)}
                <tr>
                  <td><a href={href(`/profiles/${row.profileId}`)}>{row.name}</a></td>
                  <td class="num">{row.files}</td>
                  <td class="num">{row.failing}</td>
                  <td class="num hide-sm">{formatEstimate(row.durationSec)}</td>
                  <td class="num">{formatEstimate(row.estimatedSeconds)}</td>
                  <td class="num hide-sm">{formatBytes(row.estimatedOutputBytes)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
    <p class="hint">Generated {formatDateTime(data.generatedAt)}.</p>
  {/snippet}
</Async>

<style>
  .selectors {
    margin-bottom: 1rem;
  }
  .selectors label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85em;
    color: var(--text-muted);
  }
  .selectors select {
    color: var(--text);
    min-width: 12rem;
  }
  .samples {
    max-width: 22rem;
  }
  summary {
    cursor: pointer;
  }
</style>
