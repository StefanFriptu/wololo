<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { attemptOk } from '#lib/attempt.ts';
  import Modal from '#lib/components/Modal.svelte';
  import { PATH_SCOPE_LABELS } from '#lib/labels.ts';
  import type { ArrInstance, PathMapping, PathMappingInput, PathMappingScope } from '#lib/shared.ts';

  let {
    open = $bindable(false),
    mapping,
    arrInstances,
    onsaved,
  }: { open?: boolean; mapping: PathMapping | null; arrInstances: ArrInstance[]; onsaved: () => void } = $props();

  const uid = $props.id();
  const SCOPES = Object.keys(PATH_SCOPE_LABELS) as PathMappingScope[];

  let form = $state<PathMappingInput>({ scope: 'radarr', instanceId: null, remotePath: '', localPath: '' });
  let busy = $state(false);

  const scopedInstances = $derived(arrInstances.filter((instance) => instance.kind === form.scope));

  $effect(() => {
    if (!open) return;
    const source = mapping;
    untrack(() => {
      form = source
        ? { scope: source.scope, instanceId: source.instanceId, remotePath: source.remotePath, localPath: source.localPath }
        : { scope: 'radarr', instanceId: null, remotePath: '', localPath: '' };
    });
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const body: PathMappingInput = {
      ...form,
      instanceId: form.scope === 'radarr' || form.scope === 'sonarr' ? form.instanceId : null,
      remotePath: form.remotePath.trim(),
      localPath: form.localPath.trim(),
    };
    busy = true;
    const saved = await attemptOk(async () => {
      if (mapping) await api('PUT /api/v1/pathmappings/:id', { params: { id: mapping.id }, body });
      else await api('POST /api/v1/pathmappings', { body });
    }, 'Path mapping saved');
    busy = false;
    if (!saved) return;
    open = false;
    onsaved();
  }
</script>

<Modal bind:open title={mapping ? 'Edit path mapping' : 'Add path mapping'}>
  <form id="{uid}-form" onsubmit={save}>
    <div class="field">
      <label for="{uid}-scope">Application</label>
      <div class="control">
        <select id="{uid}-scope" bind:value={form.scope} onchange={() => (form.instanceId = null)}>
          {#each SCOPES as scope (scope)}<option value={scope}>{PATH_SCOPE_LABELS[scope]}</option>{/each}
        </select>
      </div>
    </div>
    {#if form.scope === 'radarr' || form.scope === 'sonarr'}
      <div class="field">
        <label for="{uid}-instance">Instance</label>
        <div class="control">
          <select
            id="{uid}-instance"
            value={form.instanceId ?? ''}
            onchange={(event) => (form.instanceId = event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
          >
            <option value="">Every {PATH_SCOPE_LABELS[form.scope]} instance</option>
            {#each scopedInstances as instance (instance.id)}<option value={instance.id}>{instance.name}</option>{/each}
          </select>
        </div>
      </div>
    {/if}
    <div class="field">
      <label for="{uid}-remote">Remote path</label>
      <div class="control">
        <input id="{uid}-remote" bind:value={form.remotePath} required placeholder="/vault/media" autocomplete="off" />
        <span class="hint">The path as {PATH_SCOPE_LABELS[form.scope]} sees it.</span>
      </div>
    </div>
    <div class="field">
      <label for="{uid}-local">Local path</label>
      <div class="control">
        <input id="{uid}-local" bind:value={form.localPath} required placeholder="/data/media" autocomplete="off" />
        <span class="hint">The same folder inside the Wololo container.</span>
      </div>
    </div>
  </form>
  {#snippet footer()}
    <button type="button" onclick={() => (open = false)}>Cancel</button>
    <button class="primary" type="submit" form="{uid}-form" disabled={busy}>Save</button>
  {/snippet}
</Modal>
