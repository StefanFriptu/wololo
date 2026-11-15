<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import { downloadBlob } from '#lib/download.ts';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import { restartAndReload } from '#lib/restart.ts';
  import type { BackupInfo, RestoreResult } from '#lib/shared.ts';
  import { attempt, toasts } from '#lib/toast.svelte.ts';

  const KIND_LABELS: Record<BackupInfo['kind'], string> = {
    manual: 'Manual',
    scheduled: 'Scheduled',
    pre_restore: 'Before restore',
  };

  const backups = new Resource((signal) => api('GET /api/v1/system/backups', { signal }));
  let busy = $state(false);
  let restartPending = $state(false);
  let restarting = $state(false);
  let upload = $state<FileList | null>(null);

  $effect(() => {
    untrack(() => backups.load());
  });

  async function create(): Promise<void> {
    busy = true;
    const created = await attempt(() => api('POST /api/v1/system/backups'), (info) => `Backup ${info.name} created`);
    if (created) await backups.load({ silent: true });
    busy = false;
  }

  async function download(backup: BackupInfo): Promise<void> {
    try {
      downloadBlob(await api('GET /api/v1/system/backups/:name', { params: { name: backup.name } }), backup.name);
    } catch (error) {
      toasts.error(error);
    }
  }

  async function remove(backup: BackupInfo): Promise<void> {
    if (!confirm(`Delete the backup ${backup.name}?`)) return;
    try {
      await api('DELETE /api/v1/system/backups/:name', { params: { name: backup.name } });
      toasts.success('Backup deleted');
      await backups.load({ silent: true });
    } catch (error) {
      toasts.error(error);
    }
  }

  function restored(result: RestoreResult | undefined): void {
    if (!result) return;
    restartPending = result.restartRequired;
    backups.load({ silent: true });
  }

  async function restore(backup: BackupInfo): Promise<void> {
    const question = `Restore ${backup.name}? The current database and settings are backed up first, and the restore applies on the next restart.`;
    if (!confirm(question)) return;
    busy = true;
    restored(await attempt(() => api('POST /api/v1/system/backups/:name/restore', { params: { name: backup.name } }), 'Restore prepared'));
    busy = false;
  }

  async function restoreUpload(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = upload?.[0];
    if (!file) return;
    if (!confirm(`Restore from ${file.name}? The current state is backed up first.`)) return;
    const body = new FormData();
    body.append('file', file);
    busy = true;
    restored(await attempt(() => api('POST /api/v1/system/backups/restore', { body }), 'Restore prepared'));
    busy = false;
  }

  async function restart(): Promise<void> {
    restarting = true;
    try {
      const back = await restartAndReload();
      if (!back) toasts.show('warning', 'Wololo did not come back within two minutes. Check the container logs.');
    } catch (error) {
      toasts.error(error);
    } finally {
      restarting = false;
    }
  }
</script>

<PageHeader title="Backup" subtitle="The database and settings, as a zip. Media files are not included.">
  {#snippet actions()}
    <button class="primary" onclick={create} disabled={busy}><Icon name="plus" size={16} /> Back up now</button>
  {/snippet}
</PageHeader>

{#if restartPending}
  <div class="alert tone-warning" role="status">
    <p>The restore is staged. Restart Wololo to apply it.</p>
    <button class="small" onclick={restart} disabled={restarting}><Icon name="power" size={14} /> {restarting ? 'Restarting…' : 'Restart now'}</button>
  </div>
{/if}

<section class="card">
  <h2>Backups</h2>
  <Async resource={backups} isEmpty={(list) => list.length === 0} emptyText="No backups yet.">
    {#snippet children(list)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Backups</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" class="hide-sm">Type</th>
              <th scope="col" class="num">Size</th>
              <th scope="col" class="hide-sm">Created</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each list as backup (backup.name)}
              <tr>
                <td class="mono break">{backup.name}</td>
                <td class="hide-sm"><Badge label={KIND_LABELS[backup.kind]} /></td>
                <td class="num">{formatBytes(backup.sizeBytes)}</td>
                <td class="hide-sm nowrap">{formatDateTime(backup.createdAt)}</td>
                <td class="actions">
                  <button class="small" onclick={() => download(backup)} aria-label="Download {backup.name}" title="Download">
                    <Icon name="download" size={14} />
                  </button>
                  <button class="small" onclick={() => restore(backup)} disabled={busy}>Restore</button>
                  <button class="small" onclick={() => remove(backup)} aria-label="Delete {backup.name}" title="Delete">
                    <Icon name="trash" size={14} />
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

<form class="card" onsubmit={restoreUpload}>
  <h2>Restore from a file</h2>
  <div class="field">
    <label for="backup-file">Backup zip</label>
    <div class="control">
      <input id="backup-file" type="file" accept=".zip,application/zip" bind:files={upload} />
      <span class="hint">A zip downloaded from this page, from this or another Wololo.</span>
    </div>
  </div>
  <button type="submit" disabled={busy || !upload?.length}><Icon name="upload" size={16} /> Restore</button>
</form>
