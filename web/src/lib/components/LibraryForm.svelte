<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { attemptOk } from '#lib/attempt.ts';
  import FolderPicker from '#lib/components/FolderPicker.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Modal from '#lib/components/Modal.svelte';
  import { parseOptionalNumber } from '#lib/parseOptionalNumber.ts';
  import { LIBRARY_KIND_LABELS, LIBRARY_MODE_LABELS } from '#lib/labels.ts';
  import { parseList } from '#lib/parseList.ts';
  import {
    type ArrInstance,
    LIBRARY_KINDS,
    LIBRARY_MODES,
    type Library,
    type LibraryInput,
    type ProfileWithUsage,
  } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let {
    open = $bindable(false),
    library,
    profiles,
    arrInstances,
    onsaved,
  }: {
    open?: boolean;
    library: Library | null;
    profiles: ProfileWithUsage[];
    arrInstances: ArrInstance[];
    onsaved: () => void;
  } = $props();

  const uid = $props.id();
  type LanguageFill = 'off' | 'original' | 'fixed';

  let form = $state<LibraryInput>(blank());
  let languages = $state('');
  let fill = $state<LanguageFill>('off');
  let fillCode = $state('');
  let pickerOpen = $state(false);
  let pickerIndex = $state(0);
  let busy = $state(false);

  function blank(): LibraryInput {
    return {
      name: '',
      kind: 'movies',
      enabled: true,
      roots: [''],
      profileIds: [],
      mode: 'replace',
      keepLanguages: [],
      keepOriginalLanguage: true,
      keepUndetermined: true,
      fillMissingLanguage: 'off',
      arrInstanceId: null,
      bdmvEnabled: true,
      discsOnly: false,
    };
  }

  function reset(source: Library | null): void {
    form = source
      ? {
          name: source.name,
          kind: source.kind,
          enabled: source.enabled,
          roots: source.roots.length > 0 ? source.roots.map((root) => root.path) : [''],
          profileIds: [...source.profileIds],
          mode: source.mode,
          keepLanguages: [...source.keepLanguages],
          keepOriginalLanguage: source.keepOriginalLanguage,
          keepUndetermined: source.keepUndetermined,
          fillMissingLanguage: source.fillMissingLanguage,
          arrInstanceId: source.arrInstanceId,
          bdmvEnabled: source.bdmvEnabled,
          discsOnly: source.discsOnly,
        }
      : blank();
    languages = (form.keepLanguages ?? []).join(', ');
    const current = form.fillMissingLanguage ?? 'off';
    if (current === 'off' || current === 'original') {
      fill = current === 'off' ? 'off' : 'original';
      fillCode = '';
    } else {
      fill = 'fixed';
      fillCode = current;
    }
  }

  $effect(() => {
    if (!open) return;
    const source = library;
    untrack(() => reset(source));
  });

  function browse(index: number): void {
    pickerIndex = index;
    pickerOpen = true;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const roots = form.roots.map((root) => root.trim()).filter(Boolean);
    if (roots.length === 0) {
      toasts.show('warning', 'Add at least one folder.');
      return;
    }
    const body: LibraryInput = {
      ...form,
      name: form.name.trim(),
      roots,
      keepLanguages: parseList(languages),
      fillMissingLanguage: fill === 'fixed' ? fillCode.trim().toLowerCase() || 'off' : fill,
      discsOnly: form.bdmvEnabled === true && form.discsOnly === true,
    };
    busy = true;
    const saved = await attemptOk(async () => {
      if (library) await api('PUT /api/v1/libraries/:id', { params: { id: library.id }, body });
      else await api('POST /api/v1/libraries', { body });
    }, library ? 'Library saved' : 'Library added; run a scan to find its files');
    busy = false;
    if (!saved) return;
    open = false;
    onsaved();
  }
</script>

<Modal bind:open title={library ? `Edit ${library.name}` : 'Add library'} wide>
  <form id="{uid}-form" onsubmit={save}>
    <div class="field">
      <label for="{uid}-name">Name</label>
      <div class="control"><input id="{uid}-name" bind:value={form.name} required maxlength="64" placeholder="Movies" /></div>
    </div>
    <div class="field">
      <label for="{uid}-kind">Type</label>
      <div class="control">
        <select id="{uid}-kind" bind:value={form.kind}>
          {#each LIBRARY_KINDS as kind (kind)}<option value={kind}>{LIBRARY_KIND_LABELS[kind]}</option>{/each}
        </select>
      </div>
    </div>
    <div class="field">
      <span class="label">Enabled</span>
      <div class="control">
        <label class="check"><input type="checkbox" bind:checked={form.enabled} /> Scan and process this library</label>
      </div>
    </div>
    <div class="field" role="group" aria-labelledby="{uid}-folders-label">
      <span class="label" id="{uid}-folders-label">Folders</span>
      <div class="control">
        {#each form.roots as _, index (index)}
          <div class="root">
            <input
              aria-label="Folder {index + 1}"
              bind:value={form.roots[index]}
              placeholder="/data/media/movies"
              autocomplete="off"
            />
            <button type="button" class="small" onclick={() => browse(index)}><Icon name="folder" size={14} /> Browse</button>
            {#if form.roots.length > 1}
              <button
                type="button"
                class="small"
                aria-label="Remove folder {index + 1}"
                onclick={() => (form.roots = form.roots.filter((__, position) => position !== index))}
              >
                <Icon name="close" size={14} />
              </button>
            {/if}
          </div>
        {/each}
        <button type="button" class="small add" onclick={() => (form.roots = [...form.roots, ''])}>
          <Icon name="plus" size={14} /> Add folder
        </button>
        <span class="hint">Paths inside the Wololo container, the same ones Radarr/Sonarr use (for example /data/media/movies).</span>
      </div>
    </div>
    <div class="field" role="group" aria-labelledby="{uid}-profiles-label">
      <span class="label" id="{uid}-profiles-label">Profiles</span>
      <div class="control">
        <div class="checks">
          {#each profiles as profile (profile.id)}
            <label class="check"><input type="checkbox" value={profile.id} bind:group={form.profileIds} /> {profile.name}</label>
          {/each}
        </div>
        <span class="hint">Files are converted for the strictest selected profile. None selected: no profile, and scans skip this library.</span>
      </div>
    </div>
    <div class="field" role="group" aria-labelledby="{uid}-converted-audio-label">
      <span class="label" id="{uid}-converted-audio-label">Converted audio</span>
      <div class="control">
        {#each LIBRARY_MODES as mode (mode)}
          <label class="check">
            <input type="radio" name="{uid}-mode" value={mode} bind:group={form.mode} />
            {LIBRARY_MODE_LABELS[mode]}
            <span class="muted">
              {mode === 'replace' ? 'keep only the converted track' : 'add the converted track first, keep the original'}
            </span>
          </label>
        {/each}
      </div>
    </div>
    <div class="field">
      <label for="{uid}-languages">Keep languages</label>
      <div class="control">
        <input id="{uid}-languages" bind:value={languages} placeholder="eng, ger" autocomplete="off" />
        <span class="hint">ISO 639-2 codes. Audio and subtitle tracks in other languages are removed; empty keeps every track. The last audio track is never removed.</span>
        <label class="check"><input type="checkbox" bind:checked={form.keepOriginalLanguage} /> Also keep the original language</label>
        <label class="check"><input type="checkbox" bind:checked={form.keepUndetermined} /> Keep tracks without a language tag</label>
      </div>
    </div>
    <div class="field">
      <label for="{uid}-fill">Untagged tracks</label>
      <div class="control">
        <select id="{uid}-fill" bind:value={fill}>
          <option value="off">Leave untagged</option>
          <option value="original">Tag with the original language</option>
          <option value="fixed">Tag with a fixed language</option>
        </select>
        {#if fill === 'fixed'}
          <label class="sr-only" for="{uid}-fill-code">Language code</label>
          <input id="{uid}-fill-code" bind:value={fillCode} placeholder="eng" maxlength="3" required />
        {/if}
      </div>
    </div>
    <div class="field">
      <label for="{uid}-arr">Radarr / Sonarr</label>
      <div class="control">
        <select
          id="{uid}-arr"
          value={form.arrInstanceId ?? ''}
          onchange={(event) => (form.arrInstanceId = parseOptionalNumber(event.currentTarget.value) ?? null)}
        >
          <option value="">None</option>
          {#each arrInstances as instance (instance.id)}<option value={instance.id}>{instance.name} ({instance.kind})</option>{/each}
        </select>
        <span class="hint">Gets rescans after each change and supplies the original language.</span>
      </div>
    </div>
    <div class="field">
      <span class="label">Blu-ray</span>
      <div class="control">
        <label class="check"><input type="checkbox" bind:checked={form.bdmvEnabled} /> Convert Blu-ray folders and ISOs found here</label>
        {#if form.bdmvEnabled}
          <label class="check"><input type="checkbox" bind:checked={form.discsOnly} /> Only convert discs (use for the download folder)</label>
          <span class="hint">Other files here are never indexed or changed, so seeding torrents stay intact.</span>
        {/if}
      </div>
    </div>
  </form>
  {#snippet footer()}
    <button type="button" onclick={() => (open = false)}>Cancel</button>
    <button class="primary" type="submit" form="{uid}-form" disabled={busy}>Save</button>
  {/snippet}
</Modal>

<FolderPicker
  bind:open={pickerOpen}
  start={form.roots[pickerIndex] ?? ''}
  onpick={(path) => (form.roots[pickerIndex] = path)}
/>

<style>
  .root {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .root input {
    flex: 1;
    min-width: 0;
  }
  .add {
    align-self: flex-start;
  }
</style>
