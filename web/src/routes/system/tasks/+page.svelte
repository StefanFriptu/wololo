<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import { live } from '#lib/api/live.svelte.ts';
  import { clock } from '#lib/clock.svelte.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Modal from '#lib/components/Modal.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatDuration } from '#lib/format/formatDuration.ts';
  import { formatInterval } from '#lib/format/formatInterval.ts';
  import { formatRelativeTime } from '#lib/format/formatRelativeTime.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { ScheduledTaskInfo } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';

  const tasks = new Resource((signal) => api('GET /api/v1/system/tasks', { signal }));
  let editing = $state<ScheduledTaskInfo | null>(null);
  let editOpen = $state(false);
  let interval = $state(60);
  let enabled = $state(true);
  let busy = $state(false);

  $effect(() => {
    untrack(() => tasks.load());
  });

  function replace(task: ScheduledTaskInfo): void {
    if (!tasks.data) return;
    tasks.set(tasks.data.map((item) => (item.name === task.name ? task : item)));
  }

  $effect(() =>
    live.on((event) => {
      if (!tasks.data) return;
      if (event.name === 'task.started') {
        tasks.set(tasks.data.map((item) => (item.name === event.payload.name ? { ...item, running: true } : item)));
      }
      if (event.name === 'task.finished') replace(event.payload.task);
    }),
  );
  $effect(() => live.onReconnect(() => tasks.load({ silent: true })));

  async function run(task: ScheduledTaskInfo): Promise<void> {
    const result = await attempt(() => api('POST /api/v1/system/tasks/:name/run', { params: { name: task.name } }), `${task.label} started`);
    if (result) replace(result);
  }

  function edit(task: ScheduledTaskInfo): void {
    editing = task;
    interval = task.intervalMinutes;
    enabled = task.enabled;
    editOpen = true;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!editing) return;
    const name = editing.name;
    busy = true;
    const result = await attempt(
      () => api('PUT /api/v1/system/tasks/:name', { params: { name }, body: { intervalMinutes: interval, enabled } }),
      'Task saved',
    );
    busy = false;
    if (!result) return;
    replace(result);
    editOpen = false;
  }
</script>

<PageHeader title="Tasks" subtitle="Work Wololo runs on a schedule." />

<section class="card">
  <Async resource={tasks} isEmpty={(data) => data.length === 0} emptyText="No scheduled tasks.">
    {#snippet children(data)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Scheduled tasks</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Every</th>
              <th scope="col">Last run</th>
              <th scope="col" class="hide-sm">Took</th>
              <th scope="col">Next run</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data as task (task.name)}
              <tr>
                <td>
                  <strong>{task.label}</strong>
                  {#if !task.enabled}<Badge label="Off" />{/if}
                  {#if task.running}<Badge tone="info" label="Running" />{/if}
                </td>
                <td class="nowrap">{formatInterval(task.intervalMinutes)}</td>
                <td>
                  <span title={formatDateTime(task.lastRunAt)} class="nowrap">{task.lastRunAt ? formatRelativeTime(task.lastRunAt, clock.now) : 'Never'}</span>
                  {#if task.lastResult}
                    <Badge tone={task.lastResult === 'success' ? 'success' : 'danger'} label={task.lastResult} title={task.lastMessage} />
                  {/if}
                  {#if task.lastMessage && task.lastResult === 'failure'}<div class="muted small">{task.lastMessage}</div>{/if}
                </td>
                <td class="hide-sm nowrap">{task.lastDurationMs === null ? '-' : formatDuration(task.lastDurationMs / 1000)}</td>
                <td class="nowrap" title={formatDateTime(task.nextRunAt)}>
                  {task.enabled && task.nextRunAt ? formatRelativeTime(task.nextRunAt, clock.now) : '-'}
                </td>
                <td class="actions">
                  <button class="small" onclick={() => run(task)} disabled={task.running} aria-label="Run {task.label} now" title="Run now">
                    <Icon name="play" size={14} />
                  </button>
                  <button class="small" onclick={() => edit(task)} aria-label="Edit {task.label}" title="Edit">
                    <Icon name="edit" size={14} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/snippet}
  </Async>
</section>

<Modal bind:open={editOpen} title={editing?.label ?? 'Task'}>
  <form id="task-form" onsubmit={save}>
    <div class="field">
      <label for="task-interval">Every (minutes)</label>
      <div class="control">
        <input id="task-interval" type="number" min="1" max="525600" bind:value={interval} required />
        <span class="hint">{formatInterval(interval)}</span>
      </div>
    </div>
    <div class="field">
      <span class="label">Enabled</span>
      <div class="control"><label class="check"><input type="checkbox" bind:checked={enabled} /> Run on schedule</label></div>
    </div>
  </form>
  {#snippet footer()}
    <button onclick={() => (editOpen = false)}>Cancel</button>
    <button class="primary" type="submit" form="task-form" disabled={busy}>Save</button>
  {/snippet}
</Modal>

<style>
  .small {
    font-size: 0.85em;
  }
</style>
