<script lang="ts">
  import type { Tone } from '#lib/labels.ts';

  let { tone = 'neutral', label, title }: { tone?: Tone; label: string; title?: string | null } = $props();
</script>

<span class="badge tone-{tone}" title={title ?? undefined}>{label}</span>
