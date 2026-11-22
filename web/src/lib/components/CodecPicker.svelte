<script lang="ts">
  import { untrack } from 'svelte';
  import { parseList } from '#lib/parseList.ts';
  import { partitionCodecs } from '#lib/profiles/partitionCodecs.ts';
  import { type CodecInfo, codecAllowed } from '#lib/shared.ts';

  let {
    legend,
    catalog,
    allowed = $bindable(),
    hint,
  }: { legend: string; catalog: CodecInfo[]; allowed: string[]; hint?: string } = $props();

  const uid = $props.id();
  const partition = $derived(partitionCodecs(allowed, catalog));
  let customText = $state(untrack(() => partitionCodecs(allowed, catalog).custom.join(', ')));

  function toggle(codec: string, on: boolean): void {
    const known = on ? [...partition.known, codec] : partition.known.filter((item) => item !== codec);
    const order = catalog.map((info) => info.codec);
    allowed = [...known.sort((a, b) => order.indexOf(a) - order.indexOf(b)), ...parseList(customText)];
  }

  function setCustom(text: string): void {
    customText = text;
    allowed = [...partition.known, ...parseList(text)];
  }
</script>

<fieldset class="picker">
  <legend>{legend}</legend>
  <div class="checks">
    {#each catalog as info (info.codec)}
      {@const checked = partition.known.includes(info.codec)}
      {@const viaWildcard = !checked && codecAllowed(info.codec, partition.custom)}
      <label class="check" title={info.codec}>
        <input
          type="checkbox"
          checked={checked || viaWildcard}
          disabled={viaWildcard}
          onchange={(event) => toggle(info.codec, event.currentTarget.checked)}
        />
        <span>{info.label}</span>
        {#if info.lossless}<span class="badge tone-neutral">lossless</span>{/if}
        {#if viaWildcard}<span class="muted small">(wildcard)</span>{/if}
      </label>
    {/each}
  </div>
  <label class="custom" for="{uid}-custom">Other codecs (ffprobe names, comma separated, "pcm_*" matches a prefix)</label>
  <input
    id="{uid}-custom"
    value={customText}
    oninput={(event) => setCustom(event.currentTarget.value)}
    placeholder="pcm_*, mp2"
    autocomplete="off"
  />
  {#if hint}<p class="hint">{hint}</p>{/if}
</fieldset>

<style>
  .picker {
    margin-bottom: 1.25rem;
  }
  legend {
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0 1rem;
  }
  .custom {
    display: block;
    margin: 0.6rem 0 0.25rem;
    font-size: 0.9em;
    color: var(--text-muted);
  }
  input:not([type='checkbox']) {
    width: 100%;
    max-width: 28rem;
  }
  .small {
    font-size: 0.85em;
  }
</style>
