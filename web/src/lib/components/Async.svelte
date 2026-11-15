<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import type { Resource } from '#lib/resource.svelte.ts';

  let {
    resource,
    isEmpty,
    emptyText = 'Nothing here yet.',
    empty,
    children,
  }: {
    resource: Resource<T>;
    isEmpty?: (data: T) => boolean;
    emptyText?: string;
    empty?: Snippet;
    children: Snippet<[T]>;
  } = $props();
</script>

{#if resource.data === undefined}
  {#if resource.error}
    <div class="alert tone-danger" role="alert">
      <p>{errorMessage(resource.error)}</p>
      <button class="small" onclick={() => resource.load()}>Try again</button>
    </div>
  {:else}
    <p class="loading muted" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</p>
  {/if}
{:else}
  {#if resource.error}
    <div class="alert tone-danger" role="alert">
      <p>Could not refresh: {errorMessage(resource.error)}</p>
    </div>
  {/if}
  {#if isEmpty?.(resource.data)}
    {#if empty}
      {@render empty()}
    {:else}
      <p class="empty muted">{emptyText}</p>
    {/if}
  {:else}
    {@render children(resource.data)}
  {/if}
{/if}

<style>
  .loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 0;
  }
  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .empty {
    padding: 1.5rem 0;
    text-align: center;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
