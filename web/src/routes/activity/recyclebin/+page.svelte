<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '#lib/api/client.ts';
  import Async from '#lib/components/Async.svelte';
  import Badge from '#lib/components/Badge.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import PageHeader from '#lib/components/PageHeader.svelte';
  import Pagination from '#lib/components/Pagination.svelte';
  import { formatBytes } from '#lib/format/formatBytes.ts';
  import { formatDateTime } from '#lib/format/formatDateTime.ts';
  import { formatRelativeTime } from '#lib/format/formatRelativeTime.ts';
  import { pageInRange } from '#lib/pageInRange.ts';
  import { href } from '#lib/paths.ts';
  import { Resource } from '#lib/resource.svelte.ts';
  import type { RecycleBinEntry } from '#lib/shared.ts';
  import { attempt } from '#lib/attempt.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const PAGE_SIZE = 50;

  let pageNumber = $state(1);
  let busy = $state(false);
  const now = Date.now();

  const entries = new Resource((signal) =>
    api('GET /api/v1/recyclebin', { query: { page: pageNumber, pageSize: PAGE_SIZE, sortDir: 'desc' }, signal }),
  );

  $effect(() => {
    void pageNumber;
    untrack(() => entries.load({ silent: entries.data !== undefined }));
  });

  $effect(() => {
    const target = entries.data ? pageInRange(entries.data) : null;
    if (target !== null) pageNumber = target;
  });

  const isActive = (entry: RecycleBinEntry): boolean => entry.restoredAt === null && entry.purgedAt === null;

  async function restore(entry: RecycleBinEntry): Promise<void> {
    const message =
      'Put the original back? The converted file is replaced, the file is marked "ignored" so scans do not convert it again, and Radarr/Sonarr/Plex are told.';
    if (!confirm(message)) return;
    busy = true;
    await attempt(() => api('POST /api/v1/recyclebin/:id/restore', { params: { id: entry.id } }), 'Original restored');
    await entries.load({ silent: true });
    busy = false;
  }

  async function remove(entry: RecycleBinEntry): Promise<void> {
    if (!confirm(`Delete the kept original of ${entry.originalPath} now? This cannot be undone.`)) return;
    busy = true;
    try {
      await api('DELETE /api/v1/recyclebin/:id', { params: { id: entry.id } });
      toasts.success('Deleted');
    } catch (error) {
      toasts.error(error);
    }
    await entries.load({ silent: true });
    busy = false;
  }

  async function purge(all: boolean): Promise<void> {
    const question = all
      ? 'Delete every kept original now? Restoring will no longer be possible.'
      : 'Delete the kept originals whose retention period is over?';
    if (!confirm(question)) return;
    busy = true;
    await attempt(
      () => api('POST /api/v1/recyclebin/purge', { body: { all } }),
      (result) => `Deleted ${result.purged} file(s), freed ${formatBytes(result.freedBytes)}`,
    );
    await entries.load({ silent: true });
    busy = false;
  }
</script>

<PageHeader title="Recycle bin" subtitle="Originals kept after a conversion, so a bad rule can be undone.">
  {#snippet actions()}
    <button onclick={() => purge(false)} disabled={busy}>Delete expired</button>
    <button class="danger" onclick={() => purge(true)} disabled={busy}><Icon name="trash" size={16} /> Empty</button>
  {/snippet}
</PageHeader>

<section class="card">
  <Async resource={entries} isEmpty={(data) => data.items.length === 0} emptyText="The recycle bin is empty.">
    {#snippet children(data)}
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Recycle bin</caption>
          <thead>
            <tr>
              <th scope="col">Original</th>
              <th scope="col" class="num">Size</th>
              <th scope="col" class="hide-sm">Kept since</th>
              <th scope="col">State</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as entry (entry.id)}
              <tr>
                <td class="path">
                  {#if entry.mediaFileId !== null}
                    <a href={href(`/library/${entry.mediaFileId}`)}>{entry.originalPath}</a>
                  {:else}
                    {entry.originalPath}
                  {/if}
                  {#if entry.jobId !== null}
                    <a class="muted small" href={href(`/activity/jobs/${entry.jobId}`)}>job #{entry.jobId}</a>
                  {/if}
                </td>
                <td class="num">{formatBytes(entry.sizeBytes)}</td>
                <td class="hide-sm nowrap">{formatDateTime(entry.createdAt)}</td>
                <td>
                  {#if entry.restoredAt}
                    <Badge tone="info" label="Restored" title={formatDateTime(entry.restoredAt)} />
                  {:else if entry.purgedAt}
                    <Badge label="Deleted" title={formatDateTime(entry.purgedAt)} />
                  {:else}
                    <span class="nowrap" title={formatDateTime(entry.expiresAt)}>Deleted {formatRelativeTime(entry.expiresAt, now)}</span>
                  {/if}
                </td>
                <td class="actions">
                  {#if isActive(entry)}
                    <button class="small" onclick={() => restore(entry)} disabled={busy}>Restore</button>
                    <button class="small" onclick={() => remove(entry)} disabled={busy} aria-label="Delete now" title="Delete now">
                      <Icon name="trash" size={14} />
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onpage={(next) => (pageNumber = next)} />
    {/snippet}
  </Async>
</section>

<style>
  .path {
    min-width: 14rem;
    overflow-wrap: anywhere;
  }
  .path .small {
    display: block;
    font-size: 0.85em;
  }
</style>
