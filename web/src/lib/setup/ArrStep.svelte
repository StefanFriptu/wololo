<script lang="ts">
  import { untrack } from 'svelte';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import ArrForm from '#lib/components/ArrForm.svelte';
  import CopyButton from '#lib/components/CopyButton.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { PATH_SCOPE_LABELS } from '#lib/labels.ts';
  import { runtimeConfig } from '#lib/runtime.ts';
  import {
    type ArrInstance,
    type ArrKind,
    type PathMappingInput,
    trimTrailingSlashes,
    webhookUrl,
  } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';
  import { isLoopbackAddress, loadWebhookAddress, saveWebhookAddress } from '#lib/webhookAddress.ts';
  import CheckList from './CheckList.svelte';
  import { type ArrCheckResult, arrChecks } from './checks.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();

  let instances = $state<ArrInstance[] | null>(null);
  let results = $state<Record<number, ArrCheckResult>>({});
  let address = $state(loadWebhookAddress(() => localStorage, location.origin));
  let addWebhook = $state(true);
  let formOpen = $state(false);
  let formKind = $state<ArrKind>('sonarr');
  let running = $state(false);

  const origin = $derived(trimTrailingSlashes(address.trim()) || location.origin);

  async function checkOne(instance: ArrInstance): Promise<void> {
    results[instance.id] = {
      checks: [{ key: 'running', state: 'running', title: `Checking ${instance.name}` }],
      suggestion: null,
    };
    results[instance.id] = await arrChecks(instance, { address: origin, addWebhook });
  }

  async function run(): Promise<void> {
    running = true;
    try {
      instances = await api('GET /api/v1/arr');
      saveWebhookAddress(() => localStorage, address, location.origin);
      await Promise.all(instances.map(checkOne));
    } catch (error) {
      toasts.error(error);
    } finally {
      running = false;
    }
  }

  $effect(() => {
    ready =
      (instances?.length ?? 0) > 0 &&
      Object.values(results).every((result) =>
        result.checks.every((check) => check.state === 'ok' || check.state === 'warn'),
      );
  });

  async function addMapping(instance: ArrInstance, mapping: PathMappingInput): Promise<void> {
    try {
      await api('POST /api/v1/pathmappings', { body: mapping });
      toasts.success(`Mapped ${mapping.remotePath} → ${mapping.localPath}`);
      await checkOne(instance);
    } catch (error) {
      toasts.error(error);
    }
  }

  function add(kind: ArrKind): void {
    formKind = kind;
    formOpen = true;
  }

  const urlFor = (instance: ArrInstance): string =>
    webhookUrl({ origin, urlBase: runtimeConfig().urlBase, kind: instance.kind, instanceId: instance.id, apiKey: auth.key });

  $effect(() => {
    untrack(run);
  });
</script>

<h2>Connect Sonarr and Radarr</h2>
<p>Wololo hears about new downloads from them, so it can check each file as it arrives.</p>

<div class="field">
  <label for="setup-address">Address Sonarr/Radarr use to reach Wololo</label>
  <div class="control">
    <input id="setup-address" type="url" bind:value={address} placeholder={location.origin} aria-describedby="setup-address-hint" />
    <span id="setup-address-hint" class="hint">
      {#if isLoopbackAddress(origin)}
        <strong>Inside Docker, localhost is the other container itself.</strong> Use the host's IP (http://192.168.1.10:8585) or
        Wololo's container name (http://wololo:8585).
      {:else}
        Sonarr and Radarr call this address, so it must work from their side of the network.
      {/if}
    </span>
  </div>
</div>
<label class="check">
  <input type="checkbox" bind:checked={addWebhook} />
  Add Wololo's webhook in Sonarr/Radarr for me (Settings → Connect, named "Wololo")
</label>

{#if instances && instances.length === 0}
  <p class="muted">No Sonarr or Radarr yet.</p>
{/if}
{#each instances ?? [] as instance (instance.id)}
  {@const result = results[instance.id]}
  <section class="instance">
    <h3>{instance.name}</h3>
    {#if !addWebhook}
      <div class="field">
        <span class="label">Webhook URL</span>
        <div class="control">
          <code class="break">{urlFor(instance)}</code>
          <span class="hint">In {PATH_SCOPE_LABELS[instance.kind]} → Settings → Connect → + → Webhook, tick On Import and On Upgrade. <CopyButton text={urlFor(instance)} /></span>
        </div>
      </div>
    {/if}
    {#if result}
      <CheckList checks={result.checks} />
      {#if result.suggestion}
        {@const suggestion = result.suggestion}
        <p>
          <button class="small primary" onclick={() => addMapping(instance, suggestion)}>
            Map {suggestion.remotePath} → {suggestion.localPath}
          </button>
        </p>
      {/if}
    {/if}
  </section>
{/each}

<div class="toolbar">
  <button onclick={() => add('sonarr')}><Icon name="plus" size={16} /> Add Sonarr</button>
  <button onclick={() => add('radarr')}><Icon name="plus" size={16} /> Add Radarr</button>
  <button onclick={run} disabled={running}>{running ? 'Checking…' : 'Check again'}</button>
</div>
<ArrForm bind:open={formOpen} instance={null} kind={formKind} onsaved={run} />

<style>
  .instance {
    margin: 1rem 0;
  }
  .instance h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
</style>
