<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';

  let {
    open = $bindable(false),
    title,
    wide = false,
    children,
    footer,
  }: { open?: boolean; title: string; wide?: boolean; children: Snippet; footer?: Snippet } = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} class:wide aria-labelledby="{uid}-title" onclose={() => (open = false)}>
  {#if open}
    <header>
      <h2 id="{uid}-title">{title}</h2>
      <button class="ghost small" aria-label="Close" onclick={() => (open = false)}><Icon name="close" /></button>
    </header>
    <div class="content">{@render children()}</div>
    {#if footer}
      <footer class="toolbar end">{@render footer()}</footer>
    {/if}
  {/if}
</dialog>

<style>
  dialog {
    width: min(36rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
  }
  dialog.wide {
    width: min(56rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.5);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface);
    z-index: 1;
  }
  h2 {
    margin: 0;
  }
  .content {
    padding: 1rem;
  }
  footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
    position: sticky;
    bottom: 0;
    background: var(--surface);
  }
</style>
