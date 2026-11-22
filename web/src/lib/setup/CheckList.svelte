<script lang="ts">
  import type { SetupStep } from '#lib/shared.ts';
  import type { SetupCheck, SetupCheckState } from './SetupCheck.ts';

  let { checks, onfix }: { checks: SetupCheck[]; onfix?: (step: SetupStep) => void } = $props();

  const MARKS: Record<SetupCheckState, string> = { ok: '✓', warn: '!', bad: '✗', running: '…' };
  const LABELS: Record<SetupCheckState, string> = { ok: 'Passed', warn: 'Warning', bad: 'Failed', running: 'Checking' };
</script>

<ul class="checklist" aria-live="polite">
  {#each checks as check (check.key)}
    <li class="state-{check.state}">
      <span class="mark" aria-hidden="true">{MARKS[check.state]}</span>
      <span class="sr-only">{LABELS[check.state]}:</span>
      <span class="text">
        {check.title}
        {#if check.detail}<small class="muted">{check.detail}</small>{/if}
      </span>
      {#if check.fixStep && check.state !== 'ok' && onfix}
        <button class="small" onclick={() => check.fixStep && onfix(check.fixStep)}>Fix →</button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .checklist {
    list-style: none;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    margin: 1rem 0;
  }
  li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    gap: 0.5rem;
    align-items: start;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  li:last-child {
    border-bottom: none;
  }
  .text small {
    display: block;
  }
  .mark {
    font-weight: 700;
  }
  .state-ok .mark {
    color: var(--success-fg);
  }
  .state-warn .mark,
  .state-running .mark {
    color: var(--warning-fg);
  }
  .state-bad .mark {
    color: var(--danger-fg);
  }
</style>
