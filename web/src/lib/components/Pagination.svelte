<script lang="ts">
  import { pageRange } from '#lib/pageRange.ts';

  let {
    page,
    pageSize,
    total,
    onpage,
  }: { page: number; pageSize: number; total: number; onpage: (page: number) => void } = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const first = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  const last = $derived(Math.min(total, page * pageSize));
</script>

<nav class="pagination" aria-label="Pagination">
  <span class="muted">{first}-{last} of {total}</span>
  {#if pages > 1}
    <div class="pages">
      <button class="small" disabled={page <= 1} onclick={() => onpage(page - 1)} aria-label="Previous page">‹</button>
      {#each pageRange(page, pages) as item, index (index)}
        {#if item === null}
          <span class="gap" aria-hidden="true">…</span>
        {:else}
          <button
            class="small"
            class:primary={item === page}
            aria-current={item === page ? 'page' : undefined}
            aria-label="Page {item}"
            onclick={() => onpage(item)}>{item}</button
          >
        {/if}
      {/each}
      <button class="small" disabled={page >= pages} onclick={() => onpage(page + 1)} aria-label="Next page">›</button>
    </div>
  {/if}
</nav>

<style>
  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .pages {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .gap {
    padding: 0 0.25rem;
  }
</style>
