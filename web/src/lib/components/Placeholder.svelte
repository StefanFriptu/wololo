<script lang="ts">
  import PageHeader from '#lib/components/PageHeader.svelte';
  import type { RouteKey } from '#lib/shared.ts';

  let { title, milestone, description, endpoints = [] }: {
    title: string;
    milestone: string;
    description: string;
    endpoints?: RouteKey[];
  } = $props();
</script>

<PageHeader {title} />

<section class="card">
  <p>{description}</p>
  <p class="muted">Planned for {milestone}.</p>
  {#if endpoints.length > 0}
    <h2>API</h2>
    <ul>
      {#each endpoints as endpoint (endpoint)}
        <li><code>{endpoint}</code></li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h2 {
    font-size: 1rem;
    margin-top: 1rem;
  }
  ul {
    margin: 0;
    padding-left: 1.25rem;
  }
</style>
