<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatEstimate } from '#lib/format/formatEstimate.ts';
  import type { Tone } from '#lib/labels.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { restarter } from '#lib/restarter.svelte.ts';
  import { runtimeConfig } from '#lib/runtime.ts';
  import type { HealthCheck } from '#lib/shared.ts';

  const HEALTH_TONES: Record<HealthCheck['level'], Tone> = { notice: 'info', warning: 'warning', error: 'danger' };

  const status = new Resource((signal) => api('GET /api/v1/system/status', { signal }));
  const health = new Resource((signal) => api('GET /api/v1/system/health', { signal }));
  const urlBase = runtimeConfig().urlBase;

  $effect(() => {
    untrack(() => {
      status.load();
      health.load();
    });
  });
</script>

<PageHeader title="Status">
  {#snippet actions()}
    <button onclick={() => restarter.run()} disabled={restarter.restarting}><Icon name="power" size={16} /> {restarter.restarting ? 'Restarting…' : 'Restart'}</button>
  {/snippet}
</PageHeader>

<section class="card">
  <h2>Health</h2>
  <Async resource={health} isEmpty={(checks) => checks.length === 0}>
    {#snippet empty()}
      <p><Badge tone="success" label="OK" /> No issues found.</p>
    {/snippet}
    {#snippet children(checks)}
      <ul class="list-plain checks">
        {#each checks as check, index (index)}
          <li>
            <Badge tone={HEALTH_TONES[check.level]} label={check.level} />
            <span>{check.message}</span>
            <span class="muted">{check.source}</span>
          </li>
        {/each}
      </ul>
    {/snippet}
  </Async>
</section>

<Async resource={status}>
  {#snippet children(info)}
    <section class="card">
      <h2>About</h2>
      <dl class="kv">
        <dt>Version</dt>
        <dd>{info.version}</dd>
        <dt>Instance</dt>
        <dd>{info.instanceName}</dd>
        <dt>Started</dt>
        <dd>{formatDateTime(info.startTime)} (up {formatEstimate(info.uptimeSec)})</dd>
        <dt>Runtime</dt>
        <dd>{info.runtime} · {info.os} {info.arch}{info.isDocker ? ' · Docker' : ''}</dd>
        <dt>Memory</dt>
        <dd>{formatBytes(info.memoryRssBytes)}</dd>
        <dt>Config folder</dt>
        <dd class="mono">{info.configDir}</dd>
        <dt>Database</dt>
        <dd><span class="mono">{info.databasePath}</span> ({formatBytes(info.databaseSizeBytes)})</dd>
        <dt>URL base</dt>
        <dd class="mono">{info.urlBase || '/'}</dd>
        <dt>API</dt>
        <dd>
          <a href="{urlBase}/api/v1/docs" target="_blank" rel="noopener">API docs <Icon name="external" size={12} /></a>
        </dd>
      </dl>
    </section>

    <section class="card">
      <h2>Tools</h2>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">External tools</caption>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">State</th>
              <th scope="col">Version</th>
              <th scope="col" class="hide-sm">Path</th>
            </tr>
          </thead>
          <tbody>
            {#each info.tools as tool (tool.name)}
              <tr>
                <td class="mono">{tool.name}</td>
                <td><Badge tone={tool.available ? 'success' : 'danger'} label={tool.available ? 'Found' : 'Missing'} /></td>
                <td class="break">{tool.version ?? '-'}</td>
                <td class="mono hide-sm break">{tool.path ?? '-'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/snippet}
</Async>

<style>
  .checks li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    align-items: baseline;
    padding: 0.35rem 0;
  }
</style>
