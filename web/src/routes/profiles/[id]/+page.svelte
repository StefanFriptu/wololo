<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '#lib/api/client.ts';
  import { attempt, attemptOk } from '#lib/attempt.ts';
  import Async from '#lib/components/Async.svelte';
  import CodecPicker from '#lib/components/CodecPicker.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { nameById } from '#lib/nameById.ts';
  import { href } from '#lib/paths.ts';
  import { audioProblems } from '#lib/profiles/audioLimits.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import {
    DOLBY_VISION_MODES,
    MAX_AUDIO_KBPS,
    maxBitrateKbps,
    type CodecCatalog,
    type Library,
    type ProfileInput,
    type ProfileTemplate,
    type ProfileWithUsage,
    type TargetAudioCodec,
  } from '#lib/shared.ts';

  const TARGETS: { value: TargetAudioCodec; label: string }[] = [
    { value: 'ac3', label: 'AC3 (Dolby Digital)' },
    { value: 'eac3', label: 'E-AC3 (Dolby Digital Plus)' },
    { value: 'aac', label: 'AAC' },
  ];
  const MAX_CHANNELS = [
    { value: 2, label: 'Stereo (2.0)' },
    { value: 6, label: '5.1' },
    { value: 8, label: '7.1' },
  ];
  function blankInput(templates: ProfileTemplate[]): ProfileInput {
    const blank = templates.find((template) => template.id === 'blank');
    if (!blank) throw new Error('The blank profile template is missing');
    return { name: '', description: '', definition: structuredClone(blank.definition) };
  }

  const rawId = $derived(page.params.id ?? '');
  const isNew = $derived(rawId === 'new');

  const data: Resource<{
    catalog: CodecCatalog;
    templates: ProfileTemplate[];
    libraries: Library[];
    existing: ProfileWithUsage | null;
    input: ProfileInput;
  }> = new Resource(async (signal) => {
    const known = data.data;
    const [reference, existing] = await Promise.all([
      known ??
        Promise.all([
          api('GET /api/v1/profiles/codecs', { signal }),
          api('GET /api/v1/profiles/templates', { signal }),
          api('GET /api/v1/libraries', { signal }),
        ]).then(([catalog, templates, libraries]) => ({ catalog, templates, libraries })),
      isNew ? null : api('GET /api/v1/profiles/:id', { params: { id: Number(rawId) }, signal }),
    ]);
    const input: ProfileInput = existing
      ? { name: existing.name, description: existing.description, definition: existing.definition }
      : blankInput(reference.templates);
    return { ...reference, existing, input };
  });

  let form = $state<ProfileInput | null>(null);
  let saved = $state('');
  let busy = $state(false);
  const dirty = $derived(form !== null && JSON.stringify(form) !== saved);
  const problems = $derived(form ? audioProblems(form.definition.audio) : []);
  const bitrateMax = $derived(form ? maxBitrateKbps(form.definition.audio.targetCodec) : MAX_AUDIO_KBPS);

  $effect(() => {
    void rawId;
    untrack(() => {
      form = null;
      data.load();
    });
  });

  $effect(() => {
    const loaded = data.data;
    if (!loaded) return;
    untrack(() => {
      form = structuredClone(loaded.input);
      saved = JSON.stringify(loaded.input);
    });
  });

  beforeNavigate(({ cancel, type }) => {
    if (!dirty || busy) return;
    if (type === 'leave') return cancel();
    if (!confirm('Discard unsaved changes to this profile?')) cancel();
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!form) return;
    const body: ProfileInput = { ...form, name: form.name.trim(), description: form.description?.trim() ?? '' };
    busy = true;
    const result = await attempt(
      () =>
        isNew
          ? api('POST /api/v1/profiles', { body })
          : api('PUT /api/v1/profiles/:id', { params: { id: Number(rawId) }, body }),
      isNew ? 'Profile created' : 'Profile saved; affected files are re-checked on the next scan',
    );
    if (result) {
      saved = JSON.stringify(form);
      if (isNew) await goto(href(`/profiles/${result.id}`), { replace: true });
      else await data.load({ silent: true });
    }
    busy = false;
  }

  async function remove(): Promise<void> {
    if (!confirm('Delete this profile?')) return;
    busy = true;
    if (await attemptOk(() => api('DELETE /api/v1/profiles/:id', { params: { id: Number(rawId) } }), 'Profile deleted')) {
      saved = JSON.stringify(form);
      await goto(href('/profiles'));
    }
    busy = false;
  }
</script>

<Async resource={data}>
  {#snippet children(loaded)}
    {@const existing = loaded.existing}
    <PageHeader title={isNew ? 'New profile' : (existing?.name ?? 'Profile')}>
      {#snippet actions()}
        {#if existing}
          <span class="muted">Version {existing.version}</span>
          <button
            onclick={remove}
            disabled={busy || existing.libraryIds.length > 0}
            title={existing.libraryIds.length > 0 ? 'Assigned to a library' : undefined}
          >
            <Icon name="trash" size={16} /> Delete
          </button>
        {/if}
      {/snippet}
    </PageHeader>

    {#if existing && existing.libraryIds.length > 0}
      <p class="muted">
        Used by {existing.libraryIds
          .map((id) => nameById(loaded.libraries, id))
          .join(', ')}. Saving changes re-checks only the files these libraries hold.
      </p>
    {/if}

    {#if form}
      <form onsubmit={save}>
        <section class="card">
          <h2>Profile</h2>
          <div class="field">
            <label for="profile-name">Name</label>
            <div class="control"><input id="profile-name" bind:value={form.name} required maxlength="64" placeholder="Living room TV" /></div>
          </div>
          <div class="field">
            <label for="profile-description">Description</label>
            <div class="control"><input id="profile-description" bind:value={form.description} maxlength="200" /></div>
          </div>
        </section>

        <section class="card">
          <h2>Audio</h2>
          <CodecPicker
            legend="Codecs the device plays"
            catalog={loaded.catalog.audio}
            bind:allowed={form.definition.audio.allowedCodecs}
            hint="Any other audio track is converted. A compatible track in the same language with as many channels makes conversion unnecessary."
          />
          <div class="field">
            <label for="target-codec">Convert to</label>
            <div class="control">
              <select id="target-codec" bind:value={form.definition.audio.targetCodec}>
                {#each TARGETS as target (target.value)}<option value={target.value}>{target.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="max-channels">Most channels</label>
            <div class="control">
              <select id="max-channels" bind:value={form.definition.audio.maxChannels}>
                {#each MAX_CHANNELS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
              </select>
              <span class="hint">Sources with more channels are downmixed (7.1 to 5.1).</span>
            </div>
          </div>
          <div class="field" role="group" aria-labelledby="bit-rate-kbps-label">
            <span class="label" id="bit-rate-kbps-label">Bit rate (kbps)</span>
            <div class="control bitrates">
              <label>Surround <input type="number" min="32" max={bitrateMax} step="1" bind:value={form.definition.audio.bitrates.surround} required /></label>
              <label>Stereo <input type="number" min="32" max={bitrateMax} step="1" bind:value={form.definition.audio.bitrates.stereo} required /></label>
              <label>Mono <input type="number" min="32" max={bitrateMax} step="1" bind:value={form.definition.audio.bitrates.mono} required /></label>
            </div>
          </div>
          {#if problems.length > 0}
            <div class="alert tone-danger" role="alert">
              {#each problems as problem (problem)}<p>{problem}</p>{/each}
            </div>
          {/if}
        </section>

        <section class="card">
          <h2>Video</h2>
          <CodecPicker
            legend="Codecs the device plays"
            catalog={loaded.catalog.video}
            bind:allowed={form.definition.video.allowedCodecs}
            hint="Video is never re-encoded: a file with another video codec is marked blocked."
          />
          <div class="field">
            <label for="dolby-vision">Dual-layer Dolby Vision</label>
            <div class="control">
              <select id="dolby-vision" bind:value={form.definition.video.dolbyVision}>
                {#each DOLBY_VISION_MODES as mode (mode)}
                  <option value={mode}>{mode === 'drop_hdr10' ? 'Keep the HDR10 base layer' : mode}</option>
                {/each}
              </select>
              <span class="hint">Applies to Blu-ray conversion. Audio jobs copy video untouched.</span>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Subtitles</h2>
          <CodecPicker
            legend="Formats the device draws itself"
            catalog={loaded.catalog.subtitle}
            bind:allowed={form.definition.subtitles.allowedCodecs}
            hint="For information only in this version: subtitles are always kept."
          />
        </section>

        <div class="toolbar save-bar">
          <a class="button" href={href('/profiles')}>Back</a>
          <span class="spacer"></span>
          {#if dirty}<span class="muted">Unsaved changes</span>{/if}
          <button class="primary" type="submit" disabled={busy || !dirty || problems.length > 0}>{isNew ? 'Create profile' : 'Save'}</button>
        </div>
      </form>
    {/if}
  {/snippet}
</Async>

<style>
  .bitrates {
    flex-direction: row !important;
    flex-wrap: wrap;
    gap: 0.75rem !important;
  }
  .bitrates label {
    display: flex;
    flex-direction: column;
    font-size: 0.9em;
    color: var(--text-muted);
  }
  .bitrates input {
    width: 7rem;
    color: var(--text);
  }
  .save-bar {
    position: sticky;
    bottom: 0;
    background: var(--bg);
    padding: 0.75rem 0;
    border-top: 1px solid var(--border);
  }
</style>
