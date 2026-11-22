<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import { href } from '#lib/paths.ts';
  import ArrStep from '#lib/setup/ArrStep.svelte';
  import CheckStep from '#lib/setup/CheckStep.svelte';
  import DownloadClientStep from '#lib/setup/DownloadClientStep.svelte';
  import ImportsStep from '#lib/setup/ImportsStep.svelte';
  import MediaStep from '#lib/setup/MediaStep.svelte';
  import PlayersStep from '#lib/setup/PlayersStep.svelte';
  import PlexStep from '#lib/setup/PlexStep.svelte';
  import { saveSetupProgress, setupProgress } from '#lib/setup/setupProgress.svelte.ts';
  import { adjacentStep, OPTIONAL_SETUP_STEPS, SETUP_STEP_LABELS } from '#lib/setup/setupSteps.ts';
  import WelcomeStep from '#lib/setup/WelcomeStep.svelte';
  import { SETUP_STEPS, type SetupStep } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let ready = $state(false);
  let saving = $state(false);

  const step = $derived(setupProgress.data?.step ?? 'welcome');
  const index = $derived(SETUP_STEPS.indexOf(step));
  const previous = $derived(adjacentStep(step, -1));
  const next = $derived(adjacentStep(step, 1));
  const optional = $derived(OPTIONAL_SETUP_STEPS.has(step));

  $effect(() => {
    untrack(() => setupProgress.load());
  });

  async function show(target: SetupStep): Promise<void> {
    ready = false;
    try {
      await saveSetupProgress({ step: target });
      document.getElementById('content')?.focus();
    } catch (error) {
      toasts.error(error);
    }
  }

  async function finish(): Promise<void> {
    saving = true;
    try {
      await saveSetupProgress({ completed: true, step: 'welcome', dismissed: false });
      toasts.success('Setup finished');
      await goto(href('/library'));
    } catch (error) {
      toasts.error(error);
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>Setup · Wololo</title></svelte:head>

{#if setupProgress.data === undefined}
  {#if setupProgress.error}
    <div class="alert tone-danger" role="alert"><p>{errorMessage(setupProgress.error)}</p></div>
  {:else}
    <p class="loading muted" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</p>
  {/if}
{:else}
  <div class="wizard">
    <nav class="steps card" aria-label="Setup steps">
      <strong class="brand">Wololo setup</strong>
      <ol>
        {#each SETUP_STEPS as item, position (item)}
          <li>
            <button
              class="step"
              class:done={position < index}
              class:current={item === step}
              aria-current={item === step ? 'step' : undefined}
              onclick={() => show(item)}
            >
              <span class="dot" aria-hidden="true">{position < index ? '✓' : position + 1}</span>
              {SETUP_STEP_LABELS[item]}
              {#if OPTIONAL_SETUP_STEPS.has(item)}<span class="sr-only">(optional)</span>{/if}
            </button>
          </li>
        {/each}
      </ol>
    </nav>

    <section class="card body">
      {#key step}
        {#if step === 'welcome'}
          <WelcomeStep bind:ready />
        {:else if step === 'players'}
          <PlayersStep bind:ready />
        {:else if step === 'media'}
          <MediaStep bind:ready />
        {:else if step === 'arr'}
          <ArrStep bind:ready />
        {:else if step === 'plex'}
          <PlexStep bind:ready />
        {:else if step === 'downloadClient'}
          <DownloadClientStep bind:ready />
        {:else if step === 'imports'}
          <ImportsStep bind:ready />
        {:else}
          <CheckStep bind:ready onfix={show} />
        {/if}
      {/key}

      <div class="toolbar nav">
        {#if previous}<button onclick={() => previous && show(previous)}>Back</button>{/if}
        <span class="spacer"></span>
        {#if next}
          {#if optional && !ready}
            <button onclick={() => next && show(next)}>Skip for now</button>
          {:else if !ready}
            <button onclick={() => next && show(next)} title="Check everything will flag what is still red">Continue anyway</button>
          {/if}
          <button class="primary" onclick={() => next && show(next)} disabled={!ready}>Next</button>
        {:else}
          {#if !ready}<button onclick={finish} disabled={saving}>Finish anyway</button>{/if}
          <button class="primary" onclick={finish} disabled={!ready || saving}>Open library</button>
        {/if}
      </div>
    </section>
  </div>
{/if}

<style>
  .wizard {
    display: grid;
    grid-template-columns: 14rem 1fr;
    gap: 1rem;
    align-items: start;
  }
  .steps ol {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.15rem;
  }
  .brand {
    color: var(--accent-text);
  }
  .step {
    width: 100%;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 0.4rem 0.5rem;
  }
  .step.done {
    color: var(--text);
  }
  .step.current {
    color: var(--text);
    font-weight: 600;
    background: var(--surface-2);
  }
  .dot {
    flex: none;
    width: 1.3rem;
    height: 1.3rem;
    border-radius: 50%;
    border: 1.5px solid var(--border);
    display: grid;
    place-items: center;
    font-size: 0.75rem;
  }
  .step.done .dot {
    border-color: var(--success-fg);
    color: var(--success-fg);
    background: var(--success-bg);
  }
  .step.current .dot {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast);
  }
  .body {
    min-width: 0;
  }
  .body :global(.toolbar:not(.nav)) {
    margin: 1rem 0;
  }
  .body :global(.card) {
    margin-top: 1rem;
  }
  .nav {
    margin-top: 1.5rem;
  }
  @media (max-width: 768px) {
    .wizard {
      grid-template-columns: 1fr;
    }
  }
</style>
