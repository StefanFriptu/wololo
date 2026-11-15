<script lang="ts">
  import '#lib/styles/app.css';
  import type { Snippet } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Sidebar from '#lib/components/Sidebar.svelte';
  import { runtimeConfig } from '#lib/runtime.ts';
  import { theme } from '#lib/theme.svelte.ts';

  let { children }: { children: Snippet } = $props();
  let menuOpen = $state(false);
  const config = runtimeConfig();
</script>

<div class="shell">
  <header class="topbar">
    <button class="icon-button menu" aria-label="Toggle menu" onclick={() => (menuOpen = !menuOpen)}>
      <Icon name="menu" />
    </button>
    <a class="brand" href="/library">Wololo</a>
    <span class="spacer"></span>
    <button class="icon-button" aria-label="Theme: {theme.choice}" title="Theme: {theme.choice}" onclick={() => theme.cycle()}>
      <Icon name="theme" />
    </button>
  </header>
  <div class="body">
    <Sidebar open={menuOpen} onnavigate={() => (menuOpen = false)} />
    {#if menuOpen}
      <button class="scrim" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
    {/if}
    <main>
      {@render children()}
      <footer class="muted">Wololo {config.version}</footer>
    </main>
  </div>
</div>

<style>
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    height: var(--header-height);
    background: var(--header-bg);
    color: var(--header-text);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 1rem;
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .brand {
    color: inherit;
    text-decoration: none;
    font-weight: 700;
    font-size: 1.2rem;
    letter-spacing: 0.02em;
  }
  .spacer {
    flex: 1;
  }
  .icon-button {
    background: transparent;
    border: none;
    color: inherit;
    padding: 0.35rem;
    display: inline-flex;
  }
  .menu {
    display: none;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  main {
    flex: 1;
    min-width: 0;
    padding: 1.25rem;
  }
  footer {
    margin-top: 2rem;
    font-size: 0.85em;
  }
  .scrim {
    display: none;
  }
  @media (max-width: 768px) {
    .menu {
      display: inline-flex;
    }
    main {
      padding: 1rem;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: var(--header-height) 0 0 0;
      background: rgb(0 0 0 / 0.4);
      border: none;
      border-radius: 0;
      z-index: 10;
    }
  }
</style>
