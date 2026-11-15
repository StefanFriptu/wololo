<script lang="ts">
  import Badge from '#lib/components/Badge.svelte';
  import { describeStream } from '#lib/format/describeStream.ts';
  import { formatChannels } from '#lib/format/formatChannels.ts';
  import { DROP_REASON_LABELS, type Tone } from '#lib/labels.ts';
  import type { MediaStream, PlannedStream } from '#lib/shared.ts';
  import type { StreamChange, StreamRow } from '#lib/streams/pairStreams.ts';

  let {
    rows,
    beforeLabel = 'Before',
    afterLabel = 'After',
    caption,
  }: { rows: StreamRow[]; beforeLabel?: string; afterLabel?: string; caption: string } = $props();

  const CHANGES: Record<StreamChange, { label: string; tone: Tone } | null> = {
    copy: { label: 'Copy', tone: 'neutral' },
    encode: { label: 'Convert', tone: 'warning' },
    retag: { label: 'Retag', tone: 'info' },
    drop: { label: 'Remove', tone: 'danger' },
    add: { label: 'Added', tone: 'success' },
    none: null,
  };

  const showAfter = $derived(rows.some((row) => row.change !== 'none'));

  function plannedText(planned: PlannedStream): string {
    if (!planned.encode) return planned.kind === 'video' ? 'unchanged' : 'copied';
    const { codec, channels, channelLayout, bitrateKbps, downmixed } = planned.encode;
    const layout = formatChannels(channels, channelLayout);
    return `${codec.toUpperCase()} ${layout} · ${bitrateKbps} kbps${downmixed ? ' · downmixed' : ''}`;
  }

  const flagsOf = (stream: MediaStream | PlannedStream): string[] =>
    [stream.default ? 'default' : null, stream.forced ? 'forced' : null].filter((flag): flag is string => !!flag);
</script>

{#snippet streamCell(stream: MediaStream)}
  {@const info = describeStream(stream)}
  <div class="codec">{info.codec} <span class="lang">{info.language}</span></div>
  {#if info.details}<div class="muted small">{info.details}</div>{/if}
  {#if info.flags.length > 0}<div class="muted small">{info.flags.join(', ')}</div>{/if}
{/snippet}

<div class="table-wrap">
  <table class="table compare">
    <caption class="sr-only">{caption}</caption>
    <thead>
      <tr>
        <th scope="col">Type</th>
        <th scope="col">{beforeLabel}</th>
        {#if showAfter}
          <th scope="col">Change</th>
          <th scope="col">{afterLabel}</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, index (index)}
        {@const change = CHANGES[row.change]}
        <tr class:dropped={row.change === 'drop'}>
          <td class="kind">{row.kind}</td>
          <td>
            {#if row.before}{@render streamCell(row.before)}{:else}<span class="muted">-</span>{/if}
          </td>
          {#if showAfter}
            <td>
              {#if change}<Badge tone={change.tone} label={change.label} />{/if}
            </td>
            <td>
              {#if row.after}
                {@render streamCell(row.after)}
              {:else if row.planned}
                <div class="codec">
                  {row.planned.encode ? row.planned.encode.codec.toUpperCase() : (row.before?.codec.toUpperCase() ?? row.planned.codec)}
                  <span class="lang">{row.planned.language ?? 'und'}</span>
                </div>
                <div class="muted small">{plannedText(row.planned)}</div>
                {#if flagsOf(row.planned).length > 0}<div class="muted small">{flagsOf(row.planned).join(', ')}</div>{/if}
              {:else if row.dropReason}
                <span class="muted small">{DROP_REASON_LABELS[row.dropReason]}</span>
              {:else}
                <span class="muted">-</span>
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .compare td {
    min-width: 9rem;
  }
  .compare td.kind {
    min-width: 0;
    text-transform: capitalize;
    color: var(--text-muted);
  }
  .codec {
    font-weight: 600;
  }
  .lang {
    font-family: var(--font-mono);
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 0.35rem;
  }
  .small {
    font-size: 0.88em;
  }
  tr.dropped .codec {
    text-decoration: line-through;
  }
</style>
