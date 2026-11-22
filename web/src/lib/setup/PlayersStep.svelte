<script lang="ts">
  import { untrack } from 'svelte';
  import { href } from '#lib/paths.ts';
  import CheckList from './CheckList.svelte';
  import { playerChecks } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false) }: { ready?: boolean } = $props();
  let checks = $state<SetupCheck[]>([{ key: 'players', state: 'running', title: 'Reading your players' }]);

  async function run(): Promise<void> {
    checks = await playerChecks();
    ready = checks.every((check) => check.state === 'ok');
  }

  $effect(() => {
    untrack(run);
  });
</script>

<h2>Your players</h2>
<p>
  A player is a TV or streaming box and the audio and video it plays. Wololo converts a file only when one of your
  players can't play it.
</p>
<CheckList {checks} />
<div class="toolbar">
  <a class="button" href={href('/profiles')}>Edit players</a>
  <button onclick={run}>Check again</button>
</div>
