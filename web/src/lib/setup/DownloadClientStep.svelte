<script lang="ts">
  import { untrack } from 'svelte';
  import DownloadClientSettings from '#lib/components/DownloadClientSettings.svelte';
  import CheckList from './CheckList.svelte';
  import { downloadClientChecks } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let checks = $state<SetupCheck[]>([]);

  async function run(): Promise<void> {
    checks = [{ key: 'qbittorrent', state: 'running', title: 'Checking qBittorrent' }];
    checks = await downloadClientChecks();
    ready = checks.length > 0 && checks.every((check) => check.state !== 'bad');
  }

  $effect(() => {
    untrack(run);
  });
</script>

<h2>qBittorrent <span class="muted">(optional)</span></h2>
<p>
  With qBittorrent connected, Wololo can tell which files are still seeding and handle them without breaking the
  torrent.
</p>
{#if checks.length > 0}<CheckList {checks} />{/if}
<div class="toolbar"><button onclick={run}>Check again</button></div>
<DownloadClientSettings />
