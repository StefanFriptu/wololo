<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { IMPORT_ACTION_LABELS } from '#lib/labels.ts';
  import { IMPORT_ACTIONS, type ImportAction, type ProfileWithUsage } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let action = $state<ImportAction | null>(null);
  let profileId = $state<number | null>(null);
  let profiles = $state<ProfileWithUsage[]>([]);

  const DESCRIPTIONS: Readonly<Record<ImportAction, string>> = {
    check_only: 'Report what needs converting under Library → Dry run and never touch a file. Recommended to start.',
    convert_strictest: 'Convert so every player of the library can play the file, then verify it and keep the original in the recycle bin.',
    convert_for_profile: 'Convert only for the player you pick, in the libraries it watches.',
  };

  async function save(next: ImportAction, nextProfileId: number | null): Promise<void> {
    const previous = { action, profileId };
    action = next;
    profileId = nextProfileId;
    try {
      const converts = next !== 'check_only';
      await api('PUT /api/v1/settings', {
        body: {
          media: { importAction: next, importProfileId: next === 'convert_for_profile' ? nextProfileId : null },
          ...(converts ? { processing: { enabled: true } } : {}),
        },
      });
    } catch (error) {
      ({ action, profileId } = previous);
      toasts.error(error);
    }
  }

  const choose = (next: ImportAction) =>
    save(next, next === 'convert_for_profile' ? (profileId ?? profiles[0]?.id ?? null) : null);

  $effect(() => {
    ready = action !== null && (action !== 'convert_for_profile' || profileId !== null);
  });

  $effect(() => {
    untrack(async () => {
      try {
        const [settings, loaded] = await Promise.all([api('GET /api/v1/settings'), api('GET /api/v1/profiles')]);
        profiles = loaded;
        profileId = settings.media.importProfileId;
        action = settings.media.importAction;
      } catch (error) {
        toasts.error(error);
      }
    });
  });
</script>

<h2>New imports</h2>
<p>What should Wololo do when Sonarr or Radarr import a file one of your players can't play?</p>
{#if action !== null}
  <fieldset class="choices">
    <legend class="sr-only">New imports</legend>
    {#each IMPORT_ACTIONS as option (option)}
      <label class="choice" class:selected={action === option}>
        <input type="radio" name="imports" checked={action === option} onchange={() => choose(option)} />
        <span>
          <strong>{IMPORT_ACTION_LABELS[option]}</strong>
          {#if option === 'convert_for_profile'}
            <select
              aria-label="Player to convert for"
              value={profileId ?? profiles[0]?.id ?? ''}
              disabled={action !== option || profiles.length === 0}
              onchange={(event) => save(option, Number(event.currentTarget.value))}
            >
              {#each profiles as profile (profile.id)}<option value={profile.id}>{profile.name}</option>{/each}
            </select>
          {/if}
          <small class="muted">{DESCRIPTIONS[option]}</small>
        </span>
      </label>
    {/each}
  </fieldset>
{/if}

<style>
  .choices {
    display: grid;
    gap: 0.5rem;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: start;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;
  }
  .choice.selected {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .choice input[type='radio'] {
    margin-top: 0.2rem;
  }
  .choice select {
    margin-left: 0.4rem;
  }
  .choice small {
    display: block;
  }
</style>
