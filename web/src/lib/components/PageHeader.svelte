<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, actions }: { title: string; actions?: Snippet } = $props();
</script>

<svelte:head>
  <title>{title} - Wololo</title>
</svelte:head>

<header class="page-header">
  <h1>{title}</h1>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
