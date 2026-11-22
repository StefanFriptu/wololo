<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import DecisionCard from '#lib/components/DecisionCard.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { href } from '#lib/paths.ts';
  import { queryString } from '#lib/queryParams.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { BdmvDecisionState } from '#lib/shared.ts';

  interface StateTab {
    param: string | undefined;
    value: BdmvDecisionState | undefined;
    label: string;
  }

  const WAITING: StateTab = { param: undefined, value: 'pending', label: 'Waiting' };
  const STATES: StateTab[] = [
    WAITING,
    { param: 'resolved', value: 'resolved', label: 'Resolved' },
    { param: 'dismissed', value: 'dismissed', label: 'Dismissed' },
    { param: 'all', value: undefined, label: 'All' },
  ];

  const tab = $derived(STATES.find((option) => option.param === (page.url.searchParams.get('state') ?? undefined)) ?? WAITING);
  const state = $derived(tab.value);

  const decisions = new Resource((signal) => api('GET /api/v1/bdmv/decisions', { query: { state }, signal }));
  const arr = new Resource((signal) => api('GET /api/v1/arr', { signal }));

  $effect(() => {
    void state;
    untrack(() => decisions.load({ silent: decisions.data !== undefined }));
  });
  $effect(() => {
    untrack(() => arr.load());
  });

  function showState(option: StateTab): void {
    goto(href(`/library/decisions${queryString({ state: option.param })}`), { replace: true, reset: false });
  }

  $effect(() =>
    live.on((event) => {
      if (event.name === 'bdmv.decision') decisions.load({ silent: true });
    }),
  );
  $effect(() => live.onReconnect(() => decisions.load({ silent: true })));
</script>

<PageHeader title="Decisions" subtitle="Blu-ray discs waiting for a choice before they can be converted." />

<div class="toolbar tabs" role="group" aria-label="Show decisions">
  {#each STATES as option (option.label)}
    <button class="small" aria-pressed={tab === option} onclick={() => showState(option)}>{option.label}</button>
  {/each}
  {#if decisions.data && state === 'pending'}
    <Badge tone={decisions.data.length > 0 ? 'warning' : 'success'} label="{decisions.data.length} waiting" />
  {/if}
</div>

<Async
  resource={decisions}
  isEmpty={(data) => data.length === 0}
  emptyText={state === 'pending' ? 'No disc needs a decision.' : 'No decisions here.'}
>
  {#snippet children(data)}
    {#each data as decision (decision.id)}
      <DecisionCard
        {decision}
        radarrInstances={(arr.data ?? []).filter((instance) => instance.kind === 'radarr' && instance.enabled)}
        onchange={() => decisions.load({ silent: true })}
      />
    {/each}
  {/snippet}
</Async>

<style>
  .tabs {
    margin-bottom: 1rem;
  }
  .tabs button[aria-pressed='true'] {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
</style>
