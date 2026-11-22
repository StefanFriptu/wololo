<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { attempt } from '#lib/attempt.ts';
  import Icon from '#lib/components/Icon.svelte';
  import LibraryForm from '#lib/components/LibraryForm.svelte';
  import type { ArrInstance, ProfileWithUsage } from '#lib/shared.ts';
  import CheckList from './CheckList.svelte';
  import { folderChecks } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let checks = $state<SetupCheck[]>([{ key: 'folders', state: 'running', title: 'Reading your media folders' }]);
  let profiles = $state<ProfileWithUsage[]>([]);
  let arrInstances = $state<ArrInstance[]>([]);
  let formOpen = $state(false);

  async function run(): Promise<void> {
    checks = await folderChecks();
    ready = checks.every((check) => check.state !== 'bad');
  }

  async function openForm(): Promise<void> {
    const loaded = await attempt(() => Promise.all([api('GET /api/v1/profiles'), api('GET /api/v1/arr')]));
    if (!loaded) return;
    [profiles, arrInstances] = loaded;
    formOpen = true;
  }

  $effect(() => {
    untrack(run);
  });
</script>

<h2>Media folders</h2>
<p>
  Add the folders Sonarr and Radarr import into, usually one for Movies and one for TV. Use the paths as Wololo's
  container sees them.
</p>
<CheckList {checks} />
<div class="toolbar">
  <button class="primary" onclick={openForm}><Icon name="plus" size={16} /> Add folder</button>
  <button onclick={run}>Check again</button>
</div>
<LibraryForm bind:open={formOpen} library={null} {profiles} {arrInstances} onsaved={run} />
