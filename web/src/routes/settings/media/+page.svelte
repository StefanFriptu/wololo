<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import LibraryForm from '#lib/components/LibraryForm.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { LIBRARY_KIND_LABELS, LIBRARY_MODE_LABELS } from '#lib/labels.ts';
  import { parseLines } from '#lib/parseLines.ts';
  import { parseList } from '#lib/parseList.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { diffSettings } from '#lib/settings/diffSettings.ts';
  import type { ArrQualityProfile, ArrRootFolder, Library, Settings } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const libraries = new Resource((signal) => api('GET /api/v1/libraries', { signal }));
  const profiles = new Resource((signal) => api('GET /api/v1/profiles', { signal }));
  const arr = new Resource((signal) => api('GET /api/v1/arr', { signal }));
  const settings = new Resource((signal) => api('GET /api/v1/settings', { signal }));

  let form = $state<Settings | null>(null);
  let extensionsText = $state('');
  let patternsText = $state('');
  let rootFolders = $state<ArrRootFolder[]>([]);
  let qualityProfiles = $state<ArrQualityProfile[]>([]);
  let editing = $state<Library | null>(null);
  let editorOpen = $state(false);
  let saving = $state(false);

  const edited = $derived.by((): Settings | null => {
    if (!form) return null;
    const extensions = parseList(extensionsText).map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));
    return { ...form, media: { ...form.media, extensions, ignorePatterns: parseLines(patternsText) } };
  });
  const patch = $derived(settings.data && edited ? diffSettings(settings.data, edited) : null);

  $effect(() => {
    untrack(() => {
      libraries.load();
      profiles.load();
      arr.load();
      settings.load();
    });
  });

  $effect(() => {
    const loaded = settings.data;
    if (!loaded) return;
    untrack(() => {
      form = structuredClone(loaded);
      extensionsText = loaded.media.extensions.join(', ');
      patternsText = loaded.media.ignorePatterns.join('\n');
    });
  });

  $effect(() => {
    const radarr = arr.data?.find((instance) => instance.kind === 'radarr' && instance.enabled);
    if (!radarr) return;
    untrack(() => {
      api('GET /api/v1/arr/:id/rootfolders', { params: { id: radarr.id } })
        .then((folders) => (rootFolders = folders))
        .catch(() => (rootFolders = []));
      api('GET /api/v1/arr/:id/qualityprofiles', { params: { id: radarr.id } })
        .then((list) => (qualityProfiles = list))
        .catch(() => (qualityProfiles = []));
    });
  });

  $effect(() =>
    live.on((event) => {
      if (event.name === 'settings.changed' && patch === null) settings.load({ silent: true });
    }),
  );

  beforeNavigate(({ cancel, type }) => {
    if (patch === null || saving) return;
    if (type === 'leave') return cancel();
    if (!confirm('Discard unsaved settings?')) cancel();
  });

  function openEditor(library: Library | null): void {
    editing = library;
    editorOpen = true;
  }

  async function removeLibrary(library: Library): Promise<void> {
    if (!confirm(`Remove the library "${library.name}"? Its files on disk are not touched; Wololo forgets their status.`)) return;
    try {
      await api('DELETE /api/v1/libraries/:id', { params: { id: library.id } });
      toasts.success('Library removed');
      await libraries.load({ silent: true });
    } catch (error) {
      toasts.error(error);
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!patch) return;
    saving = true;
    try {
      settings.set(await api('PUT /api/v1/settings', { body: patch }));
      toasts.success('Settings saved');
    } catch (error) {
      toasts.error(error);
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    if (!settings.data) return;
    form = structuredClone(settings.data);
    extensionsText = settings.data.media.extensions.join(', ');
    patternsText = settings.data.media.ignorePatterns.join('\n');
  }

  const profileName = (id: number): string => profiles.data?.find((profile) => profile.id === id)?.name ?? `#${id}`;
</script>

<PageHeader title="Media" subtitle="Libraries, processing and file handling.">
  {#snippet actions()}
    <button class="primary" onclick={() => openEditor(null)}><Icon name="plus" size={16} /> Add library</button>
  {/snippet}
</PageHeader>

<section class="card">
  <h2>Libraries</h2>
  <Async resource={libraries} isEmpty={(data) => data.length === 0}>
    {#snippet empty()}
      <p class="muted">No libraries yet. Add the folders Radarr and Sonarr import into.</p>
    {/snippet}
    {#snippet children(data)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Libraries</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Folders</th>
              <th scope="col" class="hide-sm">Profiles</th>
              <th scope="col" class="hide-sm">Audio</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data as library (library.id)}
              <tr>
                <td>
                  <strong>{library.name}</strong>
                  <div class="muted small">{LIBRARY_KIND_LABELS[library.kind]}</div>
                  {#if !library.enabled}<Badge label="Disabled" />{/if}
                </td>
                <td>
                  <ul class="list-plain">
                    {#each library.roots as root (root.id)}
                      <li class="break">
                        <span class="mono">{root.path}</span>
                        {#if !root.accessible}
                          <Badge tone="danger" label="Not reachable" />
                        {:else if root.freeBytes !== null}
                          <span class="muted small">{formatBytes(root.freeBytes)} free</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </td>
                <td class="hide-sm">{library.profileIds.length > 0 ? library.profileIds.map(profileName).join(', ') : 'Built-in'}</td>
                <td class="hide-sm">
                  {LIBRARY_MODE_LABELS[library.mode]}
                  {#if library.keepLanguages.length > 0}<div class="muted small">Keeps {library.keepLanguages.join(', ')}</div>{/if}
                </td>
                <td class="actions">
                  <button class="small" onclick={() => openEditor(library)} aria-label="Edit {library.name}"><Icon name="edit" size={14} /></button>
                  <button class="small" onclick={() => removeLibrary(library)} aria-label="Remove {library.name}"><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/snippet}
  </Async>
</section>

<Async resource={settings}>
  {#snippet children(_loaded)}
    {#if form}
      <form onsubmit={save}>
        <section class="card">
          <h2>Processing</h2>
          <div class="field">
            <span class="label">Mode</span>
            <div class="control">
              <label class="check">
                <input type="checkbox" bind:checked={form.processing.enabled} />
                <strong>Convert files</strong>
              </label>
              {#if form.processing.enabled}
                <span class="hint">Files that need work are queued and replaced after verification.</span>
              {:else}
                <span class="badge tone-warning mode">Dry run: Wololo only probes and reports. Nothing is written.</span>
              {/if}
            </div>
          </div>
          <div class="field">
            <label for="concurrency">Jobs at once</label>
            <div class="control"><input id="concurrency" type="number" min="1" max="8" bind:value={form.processing.concurrency} required /></div>
          </div>
          <div class="field">
            <span class="label">Processing window</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.processing.window.enabled} /> Only start jobs between</label>
              <div class="inline">
                <label class="sr-only" for="window-start">Window start</label>
                <input id="window-start" type="time" bind:value={form.processing.window.start} disabled={!form.processing.window.enabled} />
                <span>and</span>
                <label class="sr-only" for="window-end">Window end</label>
                <input id="window-end" type="time" bind:value={form.processing.window.end} disabled={!form.processing.window.enabled} />
              </div>
            </div>
          </div>
          <div class="field">
            <span class="label">Plex</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.processing.pauseWhilePlexStreaming} /> Pause new jobs while Plex is streaming</label>
            </div>
          </div>
          <div class="field">
            <label for="nice">CPU priority (nice)</label>
            <div class="control">
              <input id="nice" type="number" min="0" max="19" bind:value={form.processing.niceLevel} required />
              <span class="hint">0 normal, 19 lowest.</span>
            </div>
          </div>
          <div class="field">
            <label for="ionice">Disk priority</label>
            <div class="control">
              <select id="ionice" bind:value={form.processing.ioniceClass}>
                <option value="idle">Idle (only when the disk is free)</option>
                <option value="best-effort">Best effort</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label for="attempts">Attempts per file</label>
            <div class="control"><input id="attempts" type="number" min="1" max="10" bind:value={form.processing.maxAttempts} required /></div>
          </div>
          <div class="field">
            <label for="margin">Free space margin (%)</label>
            <div class="control"><input id="margin" type="number" min="0" max="100" bind:value={form.processing.freeSpaceMarginPercent} required /></div>
          </div>
          <div class="field">
            <label for="speed">Speed for estimates</label>
            <div class="control">
              <input id="speed" type="number" min="0.1" max="100" step="0.1" bind:value={form.processing.estimatedSpeedFactor} required />
              <span class="hint">Multiple of real time used by the dry run (a Raspberry Pi 4 manages about 7.7x).</span>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Files</h2>
          <div class="field">
            <label for="extensions">File extensions</label>
            <div class="control"><input id="extensions" bind:value={extensionsText} autocomplete="off" /></div>
          </div>
          <div class="field">
            <label for="patterns">Ignore patterns</label>
            <div class="control">
              <textarea id="patterns" rows="4" bind:value={patternsText}></textarea>
              <span class="hint">One glob per line, relative to a library folder.</span>
            </div>
          </div>
          <div class="field">
            <span class="label">Imports</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.media.checkOnImport} /> Check files right after a Radarr/Sonarr import</label>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Recycle bin</h2>
          <div class="field">
            <span class="label">Keep originals</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.recycleBin.enabled} /> Keep replaced originals so they can be restored</label>
            </div>
          </div>
          <div class="field">
            <label for="retention">Keep for (days)</label>
            <div class="control"><input id="retention" type="number" min="0" max="365" bind:value={form.recycleBin.retentionDays} required /></div>
          </div>
          <div class="field">
            <label for="recycle-path">Folder</label>
            <div class="control">
              <input
                id="recycle-path"
                value={form.recycleBin.path ?? ''}
                oninput={(event) => form && (form.recycleBin.path = event.currentTarget.value.trim() || null)}
                placeholder="&lt;library folder&gt;/.wololo-recycle"
              />
              <span class="hint">Leave empty to keep originals next to the library on the same disk (needed for instant, safe replaces).</span>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Blu-ray</h2>
          <div class="field">
            <span class="label">Conversion</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.bdmv.enabled} /> Convert Blu-ray folders and ISOs to MKV</label>
            </div>
          </div>
          <div class="field">
            <label for="ambiguity">Similar lengths (%)</label>
            <div class="control">
              <input id="ambiguity" type="number" min="0" max="50" bind:value={form.bdmv.ambiguityPercent} required />
              <span class="hint">Playlists this close to the longest one count as alternative cuts.</span>
            </div>
          </div>
          <div class="field">
            <label for="on-ambiguous">Alternative cuts</label>
            <div class="control">
              <select id="on-ambiguous" bind:value={form.bdmv.onAmbiguous}>
                <option value="ask">Ask me</option>
                <option value="editions">Export all as Plex editions</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label for="match-score">Minimum Radarr match (%)</label>
            <div class="control">
              <input
                id="match-score"
                type="number"
                min="0"
                max="100"
                value={Math.round(form.bdmv.minMatchScore * 100)}
                oninput={(event) => form && (form.bdmv.minMatchScore = Number(event.currentTarget.value) / 100)}
                required
              />
              <span class="hint">Below this score Wololo asks which movie the disc is.</span>
            </div>
          </div>
          <div class="field">
            <span class="label">Extras</span>
            <div class="control">
              <label class="check"><input type="checkbox" bind:checked={form.bdmv.extras.enabled} /> Export extras into Featurettes/</label>
              <label class="inline">
                Longer than
                <input type="number" min="0" max="600" bind:value={form.bdmv.extras.minMinutes} disabled={!form.bdmv.extras.enabled} />
                minutes
              </label>
            </div>
          </div>
          <div class="field">
            <span class="label">Source discs</span>
            <div class="control">
              <label class="check">
                <input type="checkbox" bind:checked={form.bdmv.deleteSourceWhenSeeded} />
                Offer to delete a converted disc once its torrent met its seeding goal
              </label>
            </div>
          </div>
          <div class="field">
            <label for="root-folder">Radarr root folder</label>
            <div class="control">
              {#if rootFolders.length > 0}
                <select
                  id="root-folder"
                  value={form.bdmv.rootFolderPath ?? ''}
                  onchange={(event) => form && (form.bdmv.rootFolderPath = event.currentTarget.value || null)}
                >
                  <option value="">The one holding the disc's library</option>
                  {#each rootFolders.filter((folder) => folder.localPath !== null) as folder (folder.id)}
                    <option value={folder.localPath}>{folder.localPath}{folder.freeBytes !== null ? ` (${formatBytes(folder.freeBytes)} free)` : ''}</option>
                  {/each}
                </select>
              {:else}
                <input
                  id="root-folder"
                  value={form.bdmv.rootFolderPath ?? ''}
                  oninput={(event) => form && (form.bdmv.rootFolderPath = event.currentTarget.value.trim() || null)}
                  placeholder="The one holding the disc's library"
                />
              {/if}
            </div>
          </div>
          <div class="field">
            <label for="quality-profile">Radarr quality profile</label>
            <div class="control">
              {#if qualityProfiles.length > 0}
                <select
                  id="quality-profile"
                  value={form.bdmv.qualityProfileId ?? ''}
                  onchange={(event) =>
                    form && (form.bdmv.qualityProfileId = event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
                >
                  <option value="">The instance's first profile</option>
                  {#each qualityProfiles as profile (profile.id)}<option value={profile.id}>{profile.name}</option>{/each}
                </select>
              {:else}
                <input
                  id="quality-profile"
                  type="number"
                  min="1"
                  value={form.bdmv.qualityProfileId ?? ''}
                  oninput={(event) =>
                    form && (form.bdmv.qualityProfileId = event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
                  placeholder="First profile"
                />
              {/if}
              <span class="hint">Used when Wololo adds a movie Radarr does not know yet.</span>
            </div>
          </div>
        </section>

        <div class="toolbar save-bar">
          {#if patch}<span class="muted">Unsaved changes</span>{/if}
          <span class="spacer"></span>
          <button type="button" onclick={discard} disabled={!patch || saving}>Discard</button>
          <button class="primary" type="submit" disabled={!patch || saving}>Save settings</button>
        </div>
      </form>
    {/if}
  {/snippet}
</Async>

<LibraryForm
  bind:open={editorOpen}
  library={editing}
  profiles={profiles.data ?? []}
  arrInstances={arr.data ?? []}
  onsaved={() => libraries.load({ silent: true })}
/>

<style>
  .small {
    font-size: 0.85em;
  }
  .inline {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .inline input[type='number'] {
    width: 5rem;
  }
  .mode {
    white-space: normal;
    align-self: flex-start;
  }
  .save-bar {
    position: sticky;
    bottom: 0;
    background: var(--bg);
    padding: 0.75rem 0;
    border-top: 1px solid var(--border);
  }
</style>
