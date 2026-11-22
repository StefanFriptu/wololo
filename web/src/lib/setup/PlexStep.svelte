<script lang="ts">
  import { untrack } from 'svelte';
  import PlexSettings from '#lib/components/PlexSettings.svelte';
  import CheckList from './CheckList.svelte';
  import { plexChecks } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let checks = $state<SetupCheck[]>([]);

  async function run(): Promise<void> {
    checks = [{ key: 'plex', state: 'running', title: 'Checking Plex' }];
    checks = await plexChecks();
    ready = checks.length > 0 && checks.every((check) => check.state !== 'bad');
  }

  $effect(() => {
    untrack(run);
  });
</script>

<h2>Plex <span class="muted">(optional)</span></h2>
<p>
  Sign in with Plex and pick your server. Wololo then asks Plex to rescan just the folder it changed, and can pause
  conversions while someone is watching.
</p>
{#if checks.length > 0}<CheckList {checks} />{/if}
<div class="toolbar"><button onclick={run}>Check again</button></div>
<PlexSettings />
