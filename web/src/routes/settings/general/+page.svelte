<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '#lib/api/client.ts';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import type { GeneralConfigView } from '#lib/shared.ts';

  let general = $state<GeneralConfigView | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const webhookUrl = $derived(
    general ? `${location.origin}${general.urlBase}/api/v1/webhook/radarr?apikey=${general.apiKey}` : '',
  );

  async function load(): Promise<void> {
    try {
      general = await api('GET /api/v1/settings/general');
      error = null;
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    }
  }

  async function regenerate(): Promise<void> {
    if (!confirm('Regenerate the API key? Radarr/Sonarr webhooks must be updated afterwards.')) return;
    busy = true;
    try {
      general = await api('POST /api/v1/settings/general/apikey');
      location.reload();
    } catch (e) {
      error = e instanceof ApiError ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<PageHeader title="General" />

{#if error}
  <p class="card error">{error}</p>
{/if}

{#if general}
  <section class="card">
    <h2>Host</h2>
    <div class="field"><span>Port</span><code>{general.port}</code></div>
    <div class="field"><span>Bind address</span><code>{general.bindAddress}</code></div>
    <div class="field"><span>URL base</span><code>{general.urlBase || '/'}</code></div>
    <div class="field"><span>Instance name</span><span>{general.instanceName}</span></div>
    <div class="field"><span>Log level</span><span>{general.logLevel}</span></div>
    {#if general.restartRequired}
      <p class="muted">Restart Wololo to apply host changes.</p>
    {/if}
  </section>

  <section class="card">
    <h2>Security</h2>
    <div class="field">
      <span>API key</span>
      <span class="key">
        <code>{general.apiKey}</code>
        <button onclick={regenerate} disabled={busy}>Regenerate</button>
      </span>
    </div>
    <div class="field">
      <span>Radarr webhook URL</span>
      <code class="wrap">{webhookUrl}</code>
    </div>
  </section>
{/if}

<style>
  section + section {
    margin-top: 1rem;
  }
  h2 {
    font-size: 1rem;
  }
  .key {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .wrap {
    word-break: break-all;
  }
  .error {
    border-color: var(--status-failed);
    color: var(--status-failed);
  }
</style>
