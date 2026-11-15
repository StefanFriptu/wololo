<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import DecisionCard from '#lib/components/DecisionCard.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { BdmvDecisionState } from '#lib/shared.ts';

  const STATES: { value: BdmvDecisionState | undefined; label: string }[] = [
    { value: 'pending', label: 'Waiting' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'dismissed', label: 'Dismissed' },
    { value: undefined, label: 'All' },
  ];

  let state = $state<BdmvDecisionState | undefined>('pending');

  const decisions = new Resource((signal) => api('GET /api/v1/bdmv/decisions', { query: { state }, signal }));
  const arr = new Resource((signal) => api('GET /api/v1/arr', { signal }));

  $effect(() => {
    void state;
    untrack(() => decisions.load({ silent: decisions.data !== undefined }));
  });
  $effect(() => {
    untrack(() => arr.load());
  });

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
    <button class="small" aria-pressed={state === option.value} onclick={() => (state = option.value)}>{option.label}</button>
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
