<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { syncPlexConnection } from '#lib/plex/syncPlexConnection.svelte.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { ConnectionTestResult, PlexConnection, PlexConnectionUpdate, PlexPin } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const PIN_POLL_MS = 2000;

  const connection = new Resource((signal) => api('GET /api/v1/plex', { signal }));
  const servers = new Resource((signal) => api('GET /api/v1/plex/servers', { signal }));
  const sections = new Resource((signal) => api('GET /api/v1/plex/sections', { signal }));
  const sessions = new Resource((signal) => api('GET /api/v1/plex/sessions', { signal }));

  let pin = $state<PinState | null>(null);
  let serverId = $state('');
  let serverUrl = $state('');
  let test = $state<ConnectionTestResult | null>(null);
  let busy = $state(false);

  interface PinState {
    pin: PlexPin;
    error: string | null;
  }

  const signedIn = $derived(connection.data?.signedIn ?? false);
  const server = $derived(servers.data?.find((item) => item.machineId === serverId) ?? null);

  $effect(() => {
    untrack(() => {
      connection.load();
    });
  });

  syncPlexConnection({
    connection: () => connection.data,
    onSavedServer: (machineId, url) => {
      serverId = machineId;
      serverUrl = url;
    },
    loadServers: () => servers.load(),
    loadServerData: () => {
      sections.load();
      sessions.load();
    },
  });

  $effect(() => {
    const active = pin;
    if (!active || active.error) return;
    const timer = setInterval(async () => {
      try {
        const status = await api('GET /api/v1/plex/pin/:id', { params: { id: active.pin.id } });
        if (status.authenticated) {
          pin = null;
          connection.set(status.connection);
          toasts.success('Signed in to Plex');
        } else if (status.expired) {
          pin = { ...active, error: 'The sign-in code expired. Start again.' };
        }
      } catch (error) {
        pin = { ...active, error: errorMessage(error) };
      }
    }, PIN_POLL_MS);
    return () => clearInterval(timer);
  });

  async function signIn(): Promise<void> {
    const popup = window.open('about:blank', 'plex-auth', 'width=800,height=700');
    busy = true;
    try {
      const created = await api('POST /api/v1/plex/pin');
      pin = { pin: created, error: null };
      if (popup) popup.location.href = created.authUrl;
    } catch (error) {
      popup?.close();
      toasts.error(error);
    } finally {
      busy = false;
    }
  }

  async function update(patch: PlexConnectionUpdate, success = 'Saved'): Promise<PlexConnection | undefined> {
    const result = await attempt(() => api('PUT /api/v1/plex', { body: patch }), success);
    if (result) connection.set(result);
    return result;
  }

  async function setFlag(flag: 'partialScan' | 'pauseWhileStreaming', value: boolean): Promise<void> {
    busy = true;
    await update({ [flag]: value });
    busy = false;
  }

  async function saveServer(): Promise<void> {
    if (!serverId || !serverUrl) return;
    busy = true;
    await update({ serverMachineId: serverId, serverUrl }, 'Server saved');
    busy = false;
  }

  async function runTest(): Promise<void> {
    busy = true;
    try {
      test = await api('POST /api/v1/plex/test');
    } catch (error) {
      test = { ok: false, message: errorMessage(error), version: null };
    } finally {
      busy = false;
    }
  }

  async function signOut(): Promise<void> {
    if (!confirm('Sign out of Plex? Wololo stops refreshing Plex after changes.')) return;
    const result = await attempt(() => api('DELETE /api/v1/plex'), 'Signed out of Plex');
    if (result) connection.set(result);
  }
</script>

<PageHeader title="Plex" subtitle="Partial scans after each change, and pausing jobs while someone is watching." />

<Async resource={connection}>
  {#snippet children(plex)}
    <section class="card">
      <h2>Account</h2>
      {#if plex.signedIn}
        <div class="row">
          <span>Signed in as <strong>{plex.username ?? 'Plex user'}</strong></span>
          <span class="spacer"></span>
          <button onclick={signOut}>Sign out</button>
        </div>
      {:else if pin}
        <p>Finish the sign-in in the Plex window. This page continues on its own.</p>
        <p>
          Code <code class="code">{pin.pin.code}</code> ·
          <a href={pin.pin.authUrl} target="_blank" rel="noopener noreferrer">Open plex.tv <Icon name="external" size={12} /></a>
        </p>
        {#if pin.error}
          <p class="alert tone-danger" role="alert">{pin.error}</p>
          <button onclick={signIn} disabled={busy}>Try again</button>
        {:else}
          <p class="muted" role="status">Waiting for plex.tv…</p>
        {/if}
      {:else}
        <p class="muted">Sign in with your Plex account to pick a server. Wololo stores only the access token.</p>
        <button class="primary" onclick={signIn} disabled={busy}>Sign in with Plex</button>
      {/if}
    </section>

    {#if signedIn}
      <section class="card">
        <h2>Server</h2>
        <Async resource={servers} isEmpty={(list) => list.length === 0} emptyText="No Plex server found on this account.">
          {#snippet children(list)}
            <div class="field">
              <label for="plex-server">Server</label>
              <div class="control">
                <select
                  id="plex-server"
                  value={serverId}
                  onchange={(event) => {
                    serverId = event.currentTarget.value;
                    serverUrl = list.find((item) => item.machineId === serverId)?.connections[0]?.uri ?? '';
                  }}
                >
                  <option value="" disabled>Choose a server</option>
                  {#each list as item (item.machineId)}
                    <option value={item.machineId}>{item.name}{item.owned ? '' : ' (shared)'}</option>
                  {/each}
                </select>
              </div>
            </div>
            {#if server}
              <div class="field">
                <label for="plex-url">Connection</label>
                <div class="control">
                  <select id="plex-url" bind:value={serverUrl}>
                    {#each server.connections as option (option.uri)}
                      <option value={option.uri}>{option.uri}{option.local ? ' (local)' : ''}{option.relay ? ' (relay)' : ''}</option>
                    {/each}
                  </select>
                  <span class="hint">Pick a local address when Wololo runs next to Plex.</span>
                </div>
              </div>
            {/if}
            <div class="toolbar">
              <button
                class="primary"
                onclick={saveServer}
                disabled={busy || !serverId || !serverUrl || (serverId === plex.serverMachineId && serverUrl === plex.serverUrl)}
              >
                Save server
              </button>
              <button onclick={runTest} disabled={busy || !plex.serverUrl}>Test</button>
              {#if test}
                <Badge tone={test.ok ? 'success' : 'danger'} label={test.ok ? 'Connected' : 'Failed'} />
                <span class="muted">{test.message}{test.version ? ` (${test.version})` : ''}</span>
              {/if}
            </div>
          {/snippet}
        </Async>
      </section>

      <section class="card">
        <h2>Behaviour</h2>
        <label class="check">
          <input type="checkbox" checked={plex.enabled} onchange={(event) => update({ enabled: event.currentTarget.checked })} />
          Use this Plex server
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={plex.partialScan}
            disabled={busy}
            onchange={(event) => setFlag('partialScan', event.currentTarget.checked)}
          />
          Scan only the changed folder after a file is replaced
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={plex.pauseWhileStreaming}
            disabled={busy}
            onchange={(event) => setFlag('pauseWhileStreaming', event.currentTarget.checked)}
          />
          Pause new jobs while someone is streaming
        </label>
      </section>

      {#if plex.serverUrl}
        <section class="card">
          <h2>Libraries in Plex</h2>
          <p class="hint">Partial scans match these folders. If Plex sees your media under another path, add a Plex path mapping in Settings > Connect.</p>
          <Async resource={sections} isEmpty={(list) => list.length === 0} emptyText="Plex reported no libraries.">
            {#snippet children(list)}
              <ul class="list-plain sections">
                {#each list as section (section.key)}
                  <li>
                    <strong>{section.title}</strong> <span class="muted">{section.type}</span>
                    <div class="mono small break">{section.locations.join(', ')}</div>
                  </li>
                {/each}
              </ul>
            {/snippet}
          </Async>
        </section>

        <section class="card">
          <div class="card-header">
            <h2>Now playing</h2>
            <button class="small" onclick={() => sessions.load()}><Icon name="refresh" size={14} /> Refresh</button>
          </div>
          <Async resource={sessions} isEmpty={(data) => data.active === 0} emptyText="Nobody is watching.">
            {#snippet children(data)}
              <ul class="list-plain sections">
                {#each data.sessions as session, index (index)}
                  <li>
                    <strong>{session.title}</strong>
                    <span class="muted">{session.user ?? 'unknown user'} · {session.state}</span>
                    {#if session.transcoding}<Badge tone="warning" label="Transcoding" />{:else}<Badge tone="success" label="Direct play" />{/if}
                  </li>
                {/each}
              </ul>
            {/snippet}
          </Async>
        </section>
      {/if}
    {/if}
  {/snippet}
</Async>

<style>
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .code {
    font-size: 1.1em;
    font-weight: 700;
    letter-spacing: 0.1em;
  }
  .sections li {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
  }
  .sections li:last-child {
    border-bottom: none;
  }
  .small {
    font-size: 0.85em;
  }
</style>
