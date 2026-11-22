<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import Modal from '#lib/components/Modal.svelte';
  import { secretForForm, secretForRequest } from '#lib/settings/secretField.ts';
  import {
    type ArrInstance,
    type ArrInstanceInput,
    type ArrKind,
    type ConnectionTestResult,
    trimTrailingSlashes,
  } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let {
    open = $bindable(false),
    instance,
    kind,
    onsaved,
  }: { open?: boolean; instance: ArrInstance | null; kind: ArrKind; onsaved: () => void } = $props();

  const uid = $props.id();
  const DEFAULT_PORTS: Record<ArrKind, number> = { radarr: 7878, sonarr: 8989 };

  let form = $state<ArrInstanceInput>({ kind: 'radarr', name: '', url: '', apiKey: '', enabled: true });
  let storedKey = $state('');
  let test = $state<ConnectionTestResult | null>(null);
  let testing = $state(false);
  let busy = $state(false);

  const label = $derived(form.kind === 'radarr' ? 'Radarr' : 'Sonarr');

  $effect(() => {
    if (!open) return;
    const source = instance;
    const fallbackKind = kind;
    untrack(() => {
      test = null;
      storedKey = source?.apiKey ?? '';
      form = source
        ? { kind: source.kind, name: source.name, url: source.url, apiKey: secretForForm(source.apiKey), enabled: source.enabled }
        : {
            kind: fallbackKind,
            name: fallbackKind === 'radarr' ? 'Radarr' : 'Sonarr',
            url: `http://localhost:${DEFAULT_PORTS[fallbackKind]}`,
            apiKey: '',
            enabled: true,
          };
    });
  });

  const withKey = (): ArrInstanceInput => ({ ...form, apiKey: secretForRequest(form.apiKey, storedKey) });

  async function runTest(): Promise<void> {
    testing = true;
    try {
      test = await api('POST /api/v1/arr/test', { body: { ...withKey(), id: instance?.id } });
    } catch (error) {
      test = { ok: false, message: errorMessage(error), version: null };
    } finally {
      testing = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const body = { ...withKey(), name: form.name.trim(), url: trimTrailingSlashes(form.url.trim()) };
    busy = true;
    try {
      if (instance) await api('PUT /api/v1/arr/:id', { params: { id: instance.id }, body });
      else await api('POST /api/v1/arr', { body });
      toasts.success(`${label} saved`);
      open = false;
      onsaved();
    } catch (error) {
      toasts.error(error);
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open title={instance ? `Edit ${instance.name}` : `Add ${label}`}>
  <form id="{uid}-form" onsubmit={save}>
    <div class="field">
      <label for="{uid}-name">Name</label>
      <div class="control"><input id="{uid}-name" bind:value={form.name} required maxlength="64" /></div>
    </div>
    <div class="field">
      <label for="{uid}-url">URL</label>
      <div class="control">
        <input id="{uid}-url" type="url" bind:value={form.url} required placeholder="http://radarr:7878" />
        <span class="hint">As Wololo reaches it, including any URL base.</span>
      </div>
    </div>
    <div class="field">
      <label for="{uid}-key">API key</label>
      <div class="control">
        <input
          id="{uid}-key"
          type="password"
          bind:value={form.apiKey}
          required={!storedKey}
          autocomplete="off"
          placeholder={storedKey ? 'Saved, leave empty to keep' : undefined}
        />
        <span class="hint">{label} > Settings > General > API Key.{storedKey ? ' Leave empty to keep the saved key.' : ''}</span>
      </div>
    </div>
    <div class="field">
      <span class="label">Enabled</span>
      <div class="control"><label class="check"><input type="checkbox" bind:checked={form.enabled} /> Use this instance</label></div>
    </div>
    {#if test}
      <p class="alert tone-{test.ok ? 'success' : 'danger'}" role="status">
        {test.message}{test.version ? ` (version ${test.version})` : ''}
      </p>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" onclick={runTest} disabled={testing || !form.url || (!form.apiKey && !storedKey)}>{testing ? 'Testing…' : 'Test'}</button>
    <span class="spacer"></span>
    <button type="button" onclick={() => (open = false)}>Cancel</button>
    <button class="primary" type="submit" form="{uid}-form" disabled={busy}>Save</button>
  {/snippet}
</Modal>
