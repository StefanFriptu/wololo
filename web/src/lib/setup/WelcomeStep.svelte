<script lang="ts">
  import { untrack } from 'svelte';
  import CheckList from './CheckList.svelte';
  import { toolChecks } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let checks = $state<SetupCheck[]>([{ key: 'tools', state: 'running', title: 'Looking for ffmpeg, ffprobe, mkvmerge and 7-Zip' }]);

  $effect(() => {
    untrack(async () => {
      checks = await toolChecks();
      ready = checks.every((check) => check.state !== 'bad');
    });
  });
</script>

<h2>Welcome to Wololo</h2>
<p>
  Wololo checks every file Sonarr and Radarr import against the TVs you watch on. When a TV can't play a file's audio,
  Wololo converts just that track, verifies the result and keeps the original in a recycle bin.
</p>
<p class="muted">This takes about 5 minutes. Each step tests itself, and your progress is saved as you go.</p>
<CheckList {checks} />
