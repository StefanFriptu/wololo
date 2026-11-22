<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';
  import Async from '#lib/components/Async.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { defaultTemplate } from '#lib/profiles/defaultTemplate.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { ProfileTemplate, ProfileTemplateId, ProfileWithUsage } from '#lib/shared.ts';

  let {
    hasProfiles = false,
    oncreated,
  }: { hasProfiles?: boolean; oncreated?: (profile: ProfileWithUsage, another: boolean) => void } = $props();

  const uid = $props.id();
  const templates = new Resource((signal) => api('GET /api/v1/profiles/templates', { signal }));

  let name = $state('');
  let chosen = $state<ProfileTemplateId | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    untrack(() => templates.load());
  });

  $effect(() => {
    const loaded = templates.data;
    if (!loaded || chosen !== null) return;
    untrack(() => (chosen = defaultTemplate(loaded)?.id ?? null));
  });

  const selected = $derived(templates.data?.find((template) => template.id === chosen));
  const canCreate = $derived(!busy && name.trim() !== '' && selected !== undefined);

  async function create(template: ProfileTemplate, another: boolean): Promise<void> {
    busy = true;
    error = null;
    try {
      const profile = await api('POST /api/v1/profiles', {
        body: { name: name.trim(), description: '', definition: structuredClone(template.definition) },
      });
      name = '';
      oncreated?.(profile, another);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (selected && canCreate) void create(selected, false);
  }
</script>

<section class="card setup">
  <h2>{hasProfiles ? 'Add a player' : 'Add your first player'}</h2>
  <div class="alert tone-info">
    <p>
      Wololo converts only what your players can't play. Not sure? Check your TV's manual or spec sheet for supported
      audio.
    </p>
  </div>

  <form onsubmit={submit}>
    <div class="field">
      <label for="{uid}-name">Player name</label>
      <div class="control">
        <input id="{uid}-name" bind:value={name} maxlength="64" placeholder="Living room TV" autocomplete="off" />
      </div>
    </div>

    <Async resource={templates} isEmpty={(data) => data.length === 0} emptyText="No templates available.">
      {#snippet children(data)}
        <fieldset class="templates">
          <legend class="sr-only">Template</legend>
          {#each data as template (template.id)}
            <label class="template" class:selected={chosen === template.id}>
              <input type="radio" name="{uid}-template" value={template.id} bind:group={chosen} />
              <strong>{template.name}</strong>
              <span class="muted">{template.description}</span>
            </label>
          {/each}
        </fieldset>
      {/snippet}
    </Async>

    {#if error}<div class="alert tone-danger" role="alert"><p>{error}</p></div>{/if}

    <div class="toolbar end">
      <button type="button" disabled={!canCreate} onclick={() => selected && create(selected, true)}>
        <Icon name="plus" size={16} /> Another player
      </button>
      <button class="primary" type="submit" disabled={!canCreate}>Create profile</button>
    </div>
  </form>
</section>

<style>
  .setup .alert {
    margin-bottom: 1rem;
  }
  .templates {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .template {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    cursor: pointer;
  }
  .template.selected {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .template input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .template:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
