<script lang="ts">
  import '#lib/styles/app.css';
  import { type Snippet, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import { pendingDecisions } from '#lib/bdmv/pendingDecisions.ts';
  import ApiKeyPrompt from '#lib/components/ApiKeyPrompt.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Sidebar from '#lib/components/Sidebar.svelte';
  import Toasts from '#lib/components/Toasts.svelte';
  import { href } from '#lib/paths.ts';
  import { runtimeConfig } from '#lib/runtime.ts';
  import { saveSetupProgress, setupProgress } from '#lib/setup/setupProgress.svelte.ts';
  import { shouldOpenSetup } from '#lib/setup/shouldOpenSetup.ts';
  import { theme } from '#lib/theme.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let { children }: { children: Snippet } = $props();
  let menuOpen = $state(false);
  const config = runtimeConfig();

  const LIVE_LABELS = {
    connecting: 'Connecting to live updates',
    open: 'Live updates connected',
    reconnecting: 'Live updates lost, reconnecting',
  } as const;

  $effect(() => {
    if (auth.needsKey) return;
    return live.connect(auth.key);
  });

  async function refreshDecisions(announce: boolean): Promise<void> {
    const before = pendingDecisions.data?.length ?? 0;
    await pendingDecisions.load({ silent: true });
    if (pendingDecisions.error) console.error('[decisions] could not count pending decisions', pendingDecisions.error);
    const after = pendingDecisions.data?.length ?? 0;
    if (announce && after > before) toasts.show('warning', 'A Blu-ray disc needs a decision: see Library > Decisions.');
  }

  $effect(() => {
    if (auth.needsKey) return;
    untrack(() => refreshDecisions(false));
    const stopEvents = live.on((event) => {
      if (event.name === 'bdmv.decision') refreshDecisions(true);
    });
    const stopReconnect = live.onReconnect(() => refreshDecisions(false));
    return () => {
      stopEvents();
      stopReconnect();
    };
  });

  const onSetupPage = $derived(page.url.pathname.slice(config.urlBase.length).startsWith('/setup'));
  const showSetupBanner = $derived(
    !onSetupPage && setupProgress.data !== undefined && !setupProgress.data.completed && !setupProgress.data.dismissed,
  );

  async function openSetupOnFirstLaunch(): Promise<void> {
    await setupProgress.load({ silent: true });
    const setup = setupProgress.data;
    if (!setup || setup.completed || setup.dismissed || onSetupPage) return;
    try {
      const [libraries, arr] = await Promise.all([api('GET /api/v1/libraries'), api('GET /api/v1/arr')]);
      if (shouldOpenSetup({ setup, libraryCount: libraries.length, arrCount: arr.length })) await goto(href('/setup'));
    } catch (error) {
      console.error('[setup] could not tell whether this is a fresh install', error);
    }
  }

  async function dismissSetup(): Promise<void> {
    try {
      await saveSetupProgress({ dismissed: true });
    } catch (error) {
      toasts.error(error);
    }
  }

  $effect(() => {
    if (auth.needsKey) return;
    untrack(() => openSetupOnFirstLaunch());
  });

  const badges = $derived({ '/library/decisions': pendingDecisions.data?.length ?? 0 });
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && menuOpen && (menuOpen = false)} />

{#if auth.needsKey}
  <ApiKeyPrompt />
{:else}
  <a class="skip" href="#content">Skip to content</a>
  <div class="shell">
    <header class="topbar">
      <button
        class="icon-button menu"
        aria-label="Menu"
        aria-expanded={menuOpen}
        aria-controls="sidebar"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon name="menu" />
      </button>
      <a class="brand" href={href('/library')}>{config.instanceName || 'Wololo'}</a>
      <span class="spacer"></span>
      <span class="live live-{live.status}" role="status" title={LIVE_LABELS[live.status]}>
        <span class="dot" aria-hidden="true"></span>
        <span class="sr-only">{LIVE_LABELS[live.status]}</span>
      </span>
      <button
        class="icon-button"
        aria-label="Theme: {theme.choice}. Switch theme"
        title="Theme: {theme.choice}"
        onclick={() => theme.cycle()}
      >
        <Icon name="theme" />
      </button>
    </header>
    <div class="body">
      <Sidebar open={menuOpen} onnavigate={() => (menuOpen = false)} {badges} />
      {#if menuOpen}
        <button class="scrim" aria-label="Close menu" tabindex="-1" onclick={() => (menuOpen = false)}></button>
      {/if}
      <main id="content" tabindex="-1">
        {#if showSetupBanner}
          <div class="alert tone-info setup-banner" role="status">
            <p>Set up Wololo in a few guided steps: players, folders, Sonarr/Radarr and Plex, each tested as you go.</p>
            <a class="button primary small" href={href('/setup')}>Run setup</a>
            <button class="small" onclick={dismissSetup}>Not now</button>
          </div>
        {/if}
        {@render children()}
        <footer class="muted">Wololo {config.version}</footer>
      </main>
    </div>
  </div>
{/if}
<Toasts />

<style>
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .skip {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 50;
    background: var(--surface);
    padding: 0.5rem 1rem;
  }
  .skip:focus {
    left: 0.5rem;
    top: 0.5rem;
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
  .topbar :global(:focus-visible) {
    outline-color: #ffffff;
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
  .icon-button:hover {
    background: rgb(255 255 255 / 0.12);
  }
  .live {
    display: inline-flex;
    padding: 0.35rem;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #ffffff;
    opacity: 0.5;
  }
  .live-open .dot {
    background: #7cf0a8;
    opacity: 1;
  }
  .live-reconnecting .dot {
    background: #ffcc66;
    opacity: 1;
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
    outline: none;
  }
  .setup-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-bottom: 1rem;
  }
  .setup-banner p {
    flex: 1 1 20rem;
    margin: 0;
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
