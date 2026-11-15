<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import Async from '#lib/components/Async.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { ConnectionTestResult, DownloadClientInput } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const BLANK: DownloadClientInput = {
    kind: 'qbittorrent',
    enabled: true,
    url: 'http://localhost:8080',
    username: 'admin',
    password: '',
    removeWhenGoalMet: false,
    category: null,
  };

  const client = new Resource((signal) => api('GET /api/v1/downloadclient', { signal }));
  let form = $state<DownloadClientInput>({ ...BLANK });
  let test = $state<ConnectionTestResult | null>(null);
  let busy = $state(false);

  $effect(() => {
    untrack(() => client.load());
  });

  $effect(() => {
    if (client.data === undefined) return;
    const loaded = client.data;
    untrack(() => {
      form = loaded ? { ...loaded } : { ...BLANK };
    });
  });

  async function runTest(): Promise<void> {
    busy = true;
    try {
      test = await api('POST /api/v1/downloadclient/test', { body: form });
    } catch (error) {
      test = { ok: false, message: errorMessage(error), version: null };
    } finally {
      busy = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    try {
      const body = { ...form, url: form.url.trim().replace(/\/+$/, ''), category: form.category?.trim() || null };
      client.set(await api('PUT /api/v1/downloadclient', { body }));
      toasts.success('qBittorrent saved');
    } catch (error) {
      toasts.error(error);
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (!confirm('Remove qBittorrent? Seeding checks stop.')) return;
    busy = true;
    try {
      await api('DELETE /api/v1/downloadclient');
      client.set(null);
      test = null;
      toasts.success('qBittorrent removed');
    } catch (error) {
      toasts.error(error);
    } finally {
      busy = false;
    }
  }
</script>

<PageHeader title="Download clients" subtitle="Optional: let Wololo see what is still seeding." />

<Async resource={client}>
  {#snippet children(current)}
    <form class="card" onsubmit={save}>
      <h2>qBittorrent</h2>
      {#if current === null}
        <p class="muted">Not set up. Fill in the Web UI address to enable seeding-aware cleanup.</p>
      {/if}
      <div class="field">
        <span class="label">Enabled</span>
        <div class="control"><label class="check"><input type="checkbox" bind:checked={form.enabled} /> Use qBittorrent</label></div>
      </div>
      <div class="field">
        <label for="qb-url">Web UI URL</label>
        <div class="control"><input id="qb-url" type="url" bind:value={form.url} required placeholder="http://qbittorrent:8080" /></div>
      </div>
      <div class="field">
        <label for="qb-user">Username</label>
        <div class="control"><input id="qb-user" bind:value={form.username} autocomplete="off" /></div>
      </div>
      <div class="field">
        <label for="qb-password">Password</label>
        <div class="control"><input id="qb-password" type="password" bind:value={form.password} autocomplete="off" /></div>
      </div>
      <div class="field">
        <label for="qb-category">Category</label>
        <div class="control">
          <input
            id="qb-category"
            value={form.category ?? ''}
            oninput={(event) => (form.category = event.currentTarget.value || null)}
            placeholder="All categories"
          />
          <span class="hint">Only look at torrents in this category, for example "radarr".</span>
        </div>
      </div>
      <div class="field">
        <span class="label">Cleanup</span>
        <div class="control">
          <label class="check">
            <input type="checkbox" bind:checked={form.removeWhenGoalMet} />
            Remove a torrent and its files once its ratio or time goal is met and Wololo replaced the file
          </label>
          <span class="hint">
            A replaced file no longer shares disk space with its torrent. Blu-ray sources are only deleted after you
            confirm (enable the offer in <a href={href('/settings/media')}>Settings > Media</a>).
          </span>
        </div>
      </div>
      {#if test}
        <p class="alert tone-{test.ok ? 'success' : 'danger'}" role="status">
          {test.message}{test.version ? ` (version ${test.version})` : ''}
        </p>
      {/if}
      <div class="toolbar">
        <button type="button" onclick={runTest} disabled={busy || !form.url}>Test</button>
        <span class="spacer"></span>
        {#if current !== null}<button type="button" onclick={remove} disabled={busy}>Remove</button>{/if}
        <button class="primary" type="submit" disabled={busy}>Save</button>
      </div>
    </form>
  {/snippet}
</Async>
