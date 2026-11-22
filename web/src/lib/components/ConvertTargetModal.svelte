<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import Modal from '#lib/components/Modal.svelte';
  import { STRICTEST_TARGET, type ConvertTarget } from '#lib/profiles/convertTargets.ts';

  let {
    open = $bindable(false),
    question,
    targets,
    onconfirm,
  }: {
    open?: boolean;
    question: string;
    targets: ConvertTarget[];
    onconfirm: (profileId: number | undefined) => void | Promise<void>;
  } = $props();

  const uid = $props.id();
  let chosen = $state<number | undefined>(STRICTEST_TARGET.profileId);

  $effect(() => {
    if (open) chosen = STRICTEST_TARGET.profileId;
  });

  async function confirm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    open = false;
    await onconfirm(chosen);
  }
</script>

<Modal bind:open title="Convert for which player?">
  <form id="{uid}-form" onsubmit={confirm}>
    <p>{question}</p>
    {#if targets.length > 0}
      <fieldset>
        <legend class="sr-only">Target player</legend>
        {#each targets as target (target.profileId ?? 'strictest')}
          <label class="check">
            <input type="radio" name="{uid}-target" value={target.profileId} bind:group={chosen} />
            {target.label}
          </label>
        {/each}
      </fieldset>
      <p class="hint">Blu-ray discs are always converted for the strictest player.</p>
    {/if}
  </form>
  {#snippet footer()}
    <button onclick={() => (open = false)}>Cancel</button>
    <button class="primary" type="submit" form="{uid}-form"><Icon name="play" size={16} /> Convert</button>
  {/snippet}
</Modal>

<style>
  fieldset {
    display: flex;
    flex-direction: column;
  }
</style>
