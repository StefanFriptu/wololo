<script lang="ts">
  import { untrack } from 'svelte';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import ArrForm from '#lib/components/ArrForm.svelte';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import CopyButton from '#lib/components/CopyButton.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import PathMappingForm from '#lib/components/PathMappingForm.svelte';
  import { PATH_SCOPE_LABELS } from '#lib/labels.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { runtimeConfig } from '#lib/runtime.ts';
  import type { ArrInstance, ArrKind, PathMapping } from '#lib/shared.ts';
  import { attempt, toasts } from '#lib/toast.svelte.ts';
  import { webhookUrl } from '#lib/webhookUrl.ts';

  const instances = new Resource((signal) => api('GET /api/v1/arr', { signal }));
  const mappings = new Resource((signal) => api('GET /api/v1/pathmappings', { signal }));
  const settings = new Resource((signal) => api('GET /api/v1/settings', { signal }));

  let arrOpen = $state(false);
  let arrEditing = $state<ArrInstance | null>(null);
  let arrKind = $state<ArrKind>('radarr');
  let mappingOpen = $state(false);
  let mappingEditing = $state<PathMapping | null>(null);

  $effect(() => {
    untrack(() => {
      instances.load();
      mappings.load();
      settings.load();
    });
  });

  const urlFor = (instance: ArrInstance): string =>
    webhookUrl({
      origin: location.origin,
      urlBase: runtimeConfig().urlBase,
      kind: instance.kind,
      instanceId: instance.id,
      apiKey: auth.key,
    });

  function editArr(instance: ArrInstance | null, kind: ArrKind = 'radarr'): void {
    arrEditing = instance;
    arrKind = instance?.kind ?? kind;
    arrOpen = true;
  }

  function editMapping(mapping: PathMapping | null): void {
    mappingEditing = mapping;
    mappingOpen = true;
  }

  async function removeArr(instance: ArrInstance): Promise<void> {
    if (!confirm(`Remove ${instance.name}? Its webhook stops working.`)) return;
    try {
      await api('DELETE /api/v1/arr/:id', { params: { id: instance.id } });
      toasts.success(`${instance.name} removed`);
      await instances.load({ silent: true });
    } catch (error) {
      toasts.error(error);
    }
  }

  async function removeMapping(mapping: PathMapping): Promise<void> {
    if (!confirm(`Remove the mapping ${mapping.remotePath} → ${mapping.localPath}?`)) return;
    try {
      await api('DELETE /api/v1/pathmappings/:id', { params: { id: mapping.id } });
      toasts.success('Path mapping removed');
      await mappings.load({ silent: true });
    } catch (error) {
      toasts.error(error);
    }
  }

  async function setRescan(rescanArr: boolean): Promise<void> {
    const updated = await attempt(() => api('PUT /api/v1/settings', { body: { notifications: { rescanArr } } }), 'Saved');
    if (updated) settings.set(updated);
  }

  function instanceName(id: number | null): string {
    if (id === null) return 'All instances';
    return instances.data?.find((instance) => instance.id === id)?.name ?? `#${id}`;
  }
</script>

<PageHeader title="Connect" subtitle="Radarr and Sonarr tell Wololo about imports; Wololo asks them to rescan after a change.">
  {#snippet actions()}
    <button class="primary" onclick={() => editArr(null, 'radarr')}><Icon name="plus" size={16} /> Radarr</button>
    <button class="primary" onclick={() => editArr(null, 'sonarr')}><Icon name="plus" size={16} /> Sonarr</button>
  {/snippet}
</PageHeader>

<section class="card">
  <h2>Radarr and Sonarr</h2>
  <Async resource={instances} isEmpty={(data) => data.length === 0}>
    {#snippet empty()}
      <p class="muted">No instance yet. Add Radarr or Sonarr, then paste the webhook URL into it.</p>
    {/snippet}
    {#snippet children(data)}
      <ul class="list-plain instances">
        {#each data as instance (instance.id)}
          <li>
            <div class="row">
              <strong>{instance.name}</strong>
              <Badge tone="info" label={instance.kind === 'radarr' ? 'Radarr' : 'Sonarr'} />
              {#if !instance.enabled}<Badge label="Disabled" />{/if}
              <span class="muted break">{instance.url}</span>
              <span class="spacer"></span>
              <button class="small" onclick={() => editArr(instance)} aria-label="Edit {instance.name}"><Icon name="edit" size={14} /></button>
              <button class="small" onclick={() => removeArr(instance)} aria-label="Remove {instance.name}"><Icon name="trash" size={14} /></button>
            </div>
            <div class="webhook">
              <span class="muted small">Webhook URL</span>
              <code class="break">{urlFor(instance)}</code>
              <CopyButton text={urlFor(instance)} />
            </div>
          </li>
        {/each}
      </ul>
      <details class="howto">
        <summary>How to add the webhook</summary>
        <ol>
          <li>In Radarr or Sonarr open Settings > Connect and add a <strong>Webhook</strong>.</li>
          <li>Tick <strong>On Import</strong> and <strong>On Upgrade</strong>.</li>
          <li>Paste the webhook URL above, method POST, and save. "Test" should succeed.</li>
        </ol>
      </details>
    {/snippet}
  </Async>
</section>

<section class="card">
  <div class="card-header">
    <h2>Path mappings</h2>
    <button class="small" onclick={() => editMapping(null)}><Icon name="plus" size={14} /> Add</button>
  </div>
  <p class="hint">Only needed when another app sees the media under a different path than Wololo (for example /vault/media vs /data/media).</p>
  <Async resource={mappings} isEmpty={(data) => data.length === 0} emptyText="No path mappings: every app uses the same paths.">
    {#snippet children(data)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Path mappings</caption>
          <thead>
            <tr>
              <th scope="col">Application</th>
              <th scope="col">Remote path</th>
              <th scope="col">Local path</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data as mapping (mapping.id)}
              <tr>
                <td>
                  {PATH_SCOPE_LABELS[mapping.scope]}
                  {#if mapping.scope === 'radarr' || mapping.scope === 'sonarr'}<div class="muted small">{instanceName(mapping.instanceId)}</div>{/if}
                </td>
                <td class="mono break">{mapping.remotePath}</td>
                <td class="mono break">{mapping.localPath}</td>
                <td class="actions">
                  <button class="small" onclick={() => editMapping(mapping)} aria-label="Edit mapping {mapping.remotePath}"><Icon name="edit" size={14} /></button>
                  <button class="small" onclick={() => removeMapping(mapping)} aria-label="Remove mapping {mapping.remotePath}"><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/snippet}
  </Async>
</section>

<section class="card">
  <h2>After a change</h2>
  {#if settings.data}
    <label class="check">
      <input
        type="checkbox"
        checked={settings.data.notifications.rescanArr}
        onchange={(event) => setRescan(event.currentTarget.checked)}
      />
      Ask Radarr/Sonarr to rescan the movie or series after Wololo replaced a file
    </label>
  {:else}
    <Async resource={settings}>{#snippet children(_data)}{/snippet}</Async>
  {/if}
</section>

<ArrForm bind:open={arrOpen} instance={arrEditing} kind={arrKind} onsaved={() => instances.load({ silent: true })} />
<PathMappingForm
  bind:open={mappingOpen}
  mapping={mappingEditing}
  arrInstances={instances.data ?? []}
  onsaved={() => mappings.load({ silent: true })}
/>

<style>
  .instances li {
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }
  .instances li:first-child {
    padding-top: 0;
  }
  .row,
  .webhook {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.6rem;
  }
  .webhook {
    margin-top: 0.4rem;
  }
  .webhook code {
    background: var(--surface-2);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius);
    flex: 1;
    min-width: 12rem;
  }
  .small {
    font-size: 0.85em;
  }
  .howto {
    margin-top: 0.75rem;
  }
  .howto summary {
    cursor: pointer;
  }
</style>
