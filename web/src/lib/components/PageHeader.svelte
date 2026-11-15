<script lang="ts">
  import type { Snippet } from 'svelte';
  import { runtimeConfig } from '#lib/runtime.ts';

  let { title, subtitle, actions }: { title: string; subtitle?: string; actions?: Snippet } = $props();

  const instanceName = runtimeConfig().instanceName || 'Wololo';
</script>

<svelte:head>
  <title>{title} - {instanceName}</title>
</svelte:head>

<header class="page-header">
  <div class="titles">
    <h1>{title}</h1>
    {#if subtitle}
      <p class="muted subtitle">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="toolbar">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .titles {
    min-width: 0;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .subtitle {
    margin: 0.2rem 0 0;
    overflow-wrap: anywhere;
  }
</style>
