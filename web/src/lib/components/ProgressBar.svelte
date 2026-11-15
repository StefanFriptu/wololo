<script lang="ts">
  import { formatPercent } from '#lib/format/formatPercent.ts';

  let { value, label }: { value: number; label: string } = $props();

  const clamped = $derived(Math.min(1, Math.max(0, value)));
</script>

<div
  class="progress"
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.floor(clamped * 100)}
>
  <div class="fill" style:width="{clamped * 100}%"></div>
  <span class="text">{formatPercent(clamped)}</span>
</div>

<style>
  .progress {
    position: relative;
    height: 1.25rem;
    min-width: 7rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--info-bg);
    border-right: 2px solid var(--info-fg);
    transition: width 0.4s ease;
  }
  .text {
    position: relative;
    display: block;
    text-align: center;
    font-size: 0.8em;
    font-weight: 600;
    line-height: 1.15rem;
    font-variant-numeric: tabular-nums;
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
</style>
