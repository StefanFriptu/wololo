<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import { toasts } from '#lib/toast.svelte.ts';
</script>

<div class="toasts" aria-live="polite" aria-relevant="additions">
  {#each toasts.items as toast (toast.id)}
    <div class="toast tone-{toast.tone}" role={toast.tone === 'danger' ? 'alert' : 'status'}>
      <span>{toast.message}</span>
      <button class="ghost small" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: min(26rem, calc(100vw - 2rem));
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    justify-content: space-between;
    padding: 0.6rem 0.75rem;
    border: 1px solid currentColor;
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
  }
  .toast button {
    color: inherit;
    padding: 0.1rem;
  }
</style>
