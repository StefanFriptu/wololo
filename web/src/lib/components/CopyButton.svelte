<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import { toasts } from '#lib/toast.svelte.ts';

  let { text, label = 'Copy' }: { text: string; label?: string } = $props();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toasts.success('Copied to the clipboard');
    } catch {
      toasts.show('warning', 'The browser blocked clipboard access (it needs HTTPS or localhost). Select and copy the text.');
    }
  }
</script>

<button class="small" type="button" onclick={copy}><Icon name="copy" size={14} /> {label}</button>
