<script lang="ts">
  import { untrack } from 'svelte';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import CopyButton from '#lib/components/CopyButton.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { LOG_LEVELS } from '#lib/logs/filterLogs.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { restartAndReload } from '#lib/restart.ts';
  import { runtimeConfig } from '#lib/runtime.ts';
  import { AUTHENTICATION_MODES, type AuthenticationMode, type GeneralConfigUpdate } from '#lib/shared.ts';
  import { type ThemeChoice, theme } from '#lib/theme.svelte.ts';
  import { attempt, toasts } from '#lib/toast.svelte.ts';

  const AUTH_LABELS: Record<AuthenticationMode, { label: string; hint: string }> = {
    disabled_for_local_addresses: {
      label: 'Not needed on the local network',
      hint: 'Browsers on your LAN open the UI directly; everyone else must enter the API key.',
    },
    required: { label: 'Always ask for the API key', hint: 'Every browser must enter the key once.' },
    disabled: {
      label: 'Never ask',
      hint: 'Only behind a reverse proxy that does its own login: anyone who reaches the port gets the key.',
    },
  };
  const THEMES: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: 'Follow the system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  const EDITABLE = ['instanceName', 'port', 'bindAddress', 'urlBase', 'logLevel', 'authentication'] as const;

  const general = new Resource((signal) => api('GET /api/v1/settings/general', { signal }));
  let form = $state<Required<GeneralConfigUpdate> | null>(null);
  let showKey = $state(false);
  let busy = $state(false);
  let restarting = $state(false);

  const patch = $derived.by((): GeneralConfigUpdate | null => {
    const current = general.data;
    if (!form || !current) return null;
    const changed = EDITABLE.filter((key) => form?.[key] !== current[key]);
    if (changed.length === 0) return null;
    return Object.fromEntries(changed.map((key) => [key, form?.[key]])) as GeneralConfigUpdate;
  });

  $effect(() => {
    untrack(() => general.load());
  });

  $effect(() => {
    const loaded = general.data;
    if (!loaded) return;
    untrack(() => {
      form = {
        instanceName: loaded.instanceName,
        port: loaded.port,
        bindAddress: loaded.bindAddress,
        urlBase: loaded.urlBase,
        logLevel: loaded.logLevel,
        authentication: loaded.authentication,
      };
    });
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!patch) return;
    busy = true;
    const result = await attempt(() => api('PUT /api/v1/settings/general', { body: patch }), 'Saved');
    if (result) general.set(result);
    busy = false;
  }

  async function regenerate(): Promise<void> {
    if (!confirm('Create a new API key? Update the webhook URLs in Radarr and Sonarr afterwards.')) return;
    busy = true;
    const result = await attempt(() => api('POST /api/v1/settings/general/apikey'), 'New API key created');
    if (result) {
      auth.accept(result.apiKey);
      general.set(result);
    }
    busy = false;
  }

  async function restart(): Promise<void> {
    if (!confirm('Restart Wololo now? Running jobs are stopped and picked up again after the restart.')) return;
    restarting = true;
    try {
      const back = await restartAndReload();
      if (!back) toasts.show('warning', 'Wololo did not come back within two minutes. Check the container logs.');
    } catch (error) {
      toasts.error(error);
    } finally {
      restarting = false;
    }
  }
</script>

<PageHeader title="General" />

<Async resource={general}>
  {#snippet children(current)}
    {#if current.restartRequired}
      <div class="alert tone-warning" role="status">
        <p>Port, bind address or URL base changed. Restart Wololo to apply them.</p>
        <button class="small" onclick={restart} disabled={restarting}>
          <Icon name="power" size={14} /> {restarting ? 'Restarting…' : 'Restart now'}
        </button>
      </div>
    {/if}

    {#if form}
      <form onsubmit={save}>
        <section class="card">
          <h2>Host</h2>
          <div class="field">
            <label for="instance-name">Instance name</label>
            <div class="control"><input id="instance-name" bind:value={form.instanceName} required maxlength="64" /></div>
          </div>
          <div class="field">
            <label for="port">Port</label>
            <div class="control"><input id="port" type="number" min="1" max="65535" bind:value={form.port} required /></div>
          </div>
          <div class="field">
            <label for="bind-address">Bind address</label>
            <div class="control">
              <input id="bind-address" bind:value={form.bindAddress} required />
              <span class="hint">"*" for every interface, or one IP address.</span>
            </div>
          </div>
          <div class="field">
            <label for="url-base">URL base</label>
            <div class="control">
              <input id="url-base" bind:value={form.urlBase} placeholder="/wololo" />
              <span class="hint">For a reverse proxy sub-path. Empty serves Wololo at the root.</span>
            </div>
          </div>
          <div class="field">
            <label for="log-level">Log level</label>
            <div class="control">
              <select id="log-level" bind:value={form.logLevel}>
                {#each LOG_LEVELS as level (level)}<option value={level}>{level}</option>{/each}
              </select>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Security</h2>
          <div class="field" role="group" aria-labelledby="web-ui-sign-in-label">
            <span class="label" id="web-ui-sign-in-label">Web UI sign-in</span>
            <div class="control">
              {#each AUTHENTICATION_MODES as mode (mode)}
                <label class="check option">
                  <input type="radio" name="authentication" value={mode} bind:group={form.authentication} />
                  <span>{AUTH_LABELS[mode].label}<span class="hint block">{AUTH_LABELS[mode].hint}</span></span>
                </label>
              {/each}
            </div>
          </div>
          <div class="field">
            <span class="label">API key</span>
            <div class="control">
              <div class="key">
                <code class="break">{showKey ? current.apiKey : '•'.repeat(Math.min(32, current.apiKey.length))}</code>
                <button type="button" class="small" onclick={() => (showKey = !showKey)} aria-pressed={showKey}>
                  {showKey ? 'Hide' : 'Show'}
                </button>
                <CopyButton text={current.apiKey} />
                <button type="button" class="small" onclick={regenerate} disabled={busy}><Icon name="key" size={14} /> New key</button>
              </div>
              <span class="hint">
                Used by the API, the Radarr/Sonarr webhooks (Settings > Connect) and
                <a href="{runtimeConfig().urlBase}/api/v1/docs" target="_blank" rel="noopener">the API docs</a>.
              </span>
            </div>
          </div>
        </section>

        <div class="toolbar save-bar">
          {#if patch}<span class="muted">Unsaved changes</span>{/if}
          <span class="spacer"></span>
          <button class="primary" type="submit" disabled={!patch || busy}>Save</button>
        </div>
      </form>
    {/if}

    <section class="card">
      <h2>Appearance</h2>
      <div class="field" role="group" aria-labelledby="theme-label">
        <span class="label" id="theme-label">Theme</span>
        <div class="control checks">
          {#each THEMES as option (option.value)}
            <label class="check">
              <input type="radio" name="theme" value={option.value} checked={theme.choice === option.value} onchange={() => theme.set(option.value)} />
              {option.label}
            </label>
          {/each}
        </div>
      </div>
    </section>
  {/snippet}
</Async>

<style>
  .key {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .key code {
    background: var(--surface-2);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius);
  }
  .option {
    align-items: flex-start;
  }
  .option input {
    margin-top: 0.2rem;
  }
  .block {
    display: block;
    margin: 0;
  }
  .save-bar {
    margin-bottom: 1rem;
  }
</style>
