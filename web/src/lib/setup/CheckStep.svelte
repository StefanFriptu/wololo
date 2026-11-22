<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import type { SetupStep } from '#lib/shared.ts';
  import { toasts } from '#lib/toast.svelte.ts';
  import { loadWebhookAddress } from '#lib/webhookAddress.ts';
  import CheckList from './CheckList.svelte';
  import {
    arrChecks,
    downloadClientChecks,
    folderChecks,
    libraryChecks,
    playerChecks,
    plexChecks,
    toolChecks,
  } from './checks.ts';
  import type { SetupCheck } from './SetupCheck.ts';

  let { ready = $bindable(false), onfix }: { ready?: boolean; onfix: (step: SetupStep) => void } = $props();
  let checks = $state<SetupCheck[]>([]);
  let running = $state(false);

  async function arrRows(): Promise<SetupCheck[]> {
    const address = loadWebhookAddress(() => localStorage, location.origin);
    const instances = await api('GET /api/v1/arr');
    if (instances.length === 0) {
      return [{ key: 'arr', state: 'bad', title: 'No Sonarr or Radarr yet', fixStep: 'arr' }];
    }
    const results = await Promise.all(instances.map((instance) => arrChecks(instance, { address, addWebhook: false })));
    return results.flatMap((result) => result.checks);
  }

  async function run(): Promise<void> {
    running = true;
    checks = [{ key: 'running', state: 'running', title: 'Running every test again' }];
    const groups = [toolChecks, playerChecks, folderChecks, arrRows, plexChecks, downloadClientChecks, libraryChecks];
    const found: SetupCheck[] = [];
    for (const group of groups) {
      try {
        found.push(...(await group()));
      } catch (error) {
        toasts.error(error);
      }
      checks = [...found, { key: 'running', state: 'running', title: 'Checking…' }];
    }
    checks = found;
    running = false;
    ready = found.every((check) => check.state !== 'bad');
  }

  $effect(() => {
    untrack(run);
  });
</script>

<h2>{running ? 'Checking everything' : ready ? 'All set' : 'Almost done'}</h2>
<p class="muted">One last end-to-end run. Anything red has a plain explanation and a button to the fix.</p>
<CheckList {checks} {onfix} />
<div class="toolbar"><button onclick={run} disabled={running}>Run checks again</button></div>
