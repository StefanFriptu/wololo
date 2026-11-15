<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Modal from '#lib/components/Modal.svelte';
  import { Resource } from '#lib/resource.svelte.ts';

  let {
    open = $bindable(false),
    start = '',
    onpick,
  }: { open?: boolean; start?: string; onpick: (path: string) => void } = $props();

  let path = $state('');
  const listing = new Resource((signal) =>
    api('GET /api/v1/filesystem', { query: { path: path || undefined }, signal }),
  );

  $effect(() => {
    if (!open) return;
    const initial = start;
    untrack(() => go(initial));
  });

  function go(next: string): void {
    path = next;
    listing.load();
  }

  function pick(): void {
    const chosen = listing.data?.path ?? path;
    if (!chosen) return;
    onpick(chosen);
    open = false;
  }
</script>

<Modal bind:open title="Choose a folder">
  <form
    class="go"
    onsubmit={(event) => {
      event.preventDefault();
      go(path);
    }}
  >
    <label class="sr-only" for="folder-path">Folder path</label>
    <input id="folder-path" bind:value={path} placeholder="/data/media" autocomplete="off" />
    <button type="submit">Go</button>
  </form>
  <Async resource={listing}>
    {#snippet children(data)}
      <ul class="list-plain entries">
        {#if data.parent !== null}
          {@const parent = data.parent}
          <li>
            <button class="ghost entry" onclick={() => go(parent)}><Icon name="up" /> ..</button>
          </li>
        {/if}
        {#each data.entries.filter((entry) => entry.type === 'dir') as entry (entry.path)}
          <li>
            <button class="ghost entry" onclick={() => go(entry.path)}><Icon name="folder" /> {entry.name}</button>
          </li>
        {:else}
          <li class="muted empty">No sub-folders.</li>
        {/each}
      </ul>
    {/snippet}
  </Async>
  {#snippet footer()}
    <button onclick={() => (open = false)}>Cancel</button>
    <button class="primary" disabled={!listing.data} onclick={pick}>Use {listing.data?.path ?? 'folder'}</button>
  {/snippet}
</Modal>

<style>
  .go {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .go input {
    flex: 1;
    min-width: 0;
  }
  .entries {
    max-height: 22rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .entry {
    width: 100%;
    justify-content: flex-start;
    border-radius: 0;
    white-space: normal;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .empty {
    padding: 0.75rem;
  }
</style>
