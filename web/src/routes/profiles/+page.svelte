<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Modal from '#lib/components/Modal.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { ProfileWithUsage } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const profiles = new Resource((signal) => api('GET /api/v1/profiles', { signal }));
  const libraries = new Resource((signal) => api('GET /api/v1/libraries', { signal }));

  let cloneSource = $state<ProfileWithUsage | null>(null);
  let cloneOpen = $state(false);
  let cloneName = $state('');
  let busy = $state(false);

  $effect(() => {
    untrack(() => {
      profiles.load();
      libraries.load();
    });
  });

  function libraryNames(ids: number[]): string {
    const names = ids.map((id) => libraries.data?.find((library) => library.id === id)?.name ?? `#${id}`);
    return names.join(', ');
  }

  function openClone(profile: ProfileWithUsage): void {
    cloneSource = profile;
    cloneName = `${profile.name} (copy)`;
    cloneOpen = true;
  }

  async function clone(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!cloneSource || !cloneName.trim()) return;
    busy = true;
    const source = cloneSource;
    const created = await attempt(
      () => api('POST /api/v1/profiles/:id/clone', { params: { id: source.id }, body: { name: cloneName.trim() } }),
      'Profile cloned',
    );
    busy = false;
    if (!created) return;
    cloneOpen = false;
    await goto(href(`/profiles/${created.id}`));
  }

  async function remove(profile: ProfileWithUsage): Promise<void> {
    if (!confirm(`Delete the profile "${profile.name}"?`)) return;
    try {
      await api('DELETE /api/v1/profiles/:id', { params: { id: profile.id } });
      toasts.success('Profile deleted');
      await profiles.load({ silent: true });
    } catch (error) {
      toasts.error(error);
    }
  }
</script>

<PageHeader title="Profiles" subtitle="What each TV decodes. A library is converted to the strictest of its profiles.">
  {#snippet actions()}
    <a class="button primary" href={href('/profiles/new')}><Icon name="plus" size={16} /> Add profile</a>
  {/snippet}
</PageHeader>

<Async resource={profiles} isEmpty={(data) => data.length === 0} emptyText="No profiles yet.">
  {#snippet children(data)}
    <div class="grid">
      {#each data as profile (profile.id)}
        {@const audio = profile.definition.audio}
        <article class="card profile">
          <header class="card-header">
            <h2><a href={href(`/profiles/${profile.id}`)}>{profile.name}</a></h2>
            {#if profile.builtin}<Badge tone="info" label="Built-in" />{/if}
          </header>
          {#if profile.description}<p class="muted">{profile.description}</p>{/if}
          <dl class="kv">
            <dt>Audio plays</dt>
            <dd class="chips">{#each audio.allowedCodecs as codec (codec)}<span class="chip">{codec}</span>{/each}</dd>
            <dt>Converts to</dt>
            <dd>
              {audio.targetCodec.toUpperCase()} · {audio.bitrates.surround}/{audio.bitrates.stereo}/{audio.bitrates.mono} kbps
            </dd>
            <dt>Video plays</dt>
            <dd class="chips">{#each profile.definition.video.allowedCodecs as codec (codec)}<span class="chip">{codec}</span>{/each}</dd>
            <dt>Used by</dt>
            <dd>{profile.libraryIds.length > 0 ? libraryNames(profile.libraryIds) : 'No library'}</dd>
          </dl>
          <footer class="toolbar">
            <a class="button small" href={href(`/profiles/${profile.id}`)}><Icon name="edit" size={14} /> Edit</a>
            <button class="small" onclick={() => openClone(profile)}><Icon name="copy" size={14} /> Clone</button>
            <span class="spacer"></span>
            <button
              class="small"
              onclick={() => remove(profile)}
              disabled={profile.builtin || profile.libraryIds.length > 0}
              title={profile.builtin ? 'The built-in profile cannot be deleted' : profile.libraryIds.length > 0 ? 'Assigned to a library' : 'Delete'}
              aria-label="Delete {profile.name}"
            >
              <Icon name="trash" size={14} />
            </button>
          </footer>
          <p class="hint">Version {profile.version}</p>
        </article>
      {/each}
    </div>
  {/snippet}
</Async>

<Modal bind:open={cloneOpen} title="Clone {cloneSource?.name ?? 'profile'}">
  <form id="clone-form" onsubmit={clone}>
    <div class="field">
      <label for="clone-name">Name</label>
      <div class="control"><input id="clone-name" bind:value={cloneName} required maxlength="64" /></div>
    </div>
  </form>
  {#snippet footer()}
    <button onclick={() => (cloneOpen = false)}>Cancel</button>
    <button class="primary" type="submit" form="clone-form" disabled={busy || !cloneName.trim()}>Clone</button>
  {/snippet}
</Modal>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
    gap: 1rem;
  }
  .profile {
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .profile h2 {
    font-size: 1.05rem;
  }
  .profile h2 a {
    color: inherit;
    text-decoration: none;
  }
  .profile h2 a:hover {
    text-decoration: underline;
  }
  .profile dl {
    flex: 1;
    margin-bottom: 0.75rem;
  }
  .hint {
    margin-top: 0.5rem;
  }
</style>
