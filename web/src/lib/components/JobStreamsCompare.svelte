<script lang="ts">
  import StreamCompare from '#lib/components/StreamCompare.svelte';
  import type { JobDetail } from '#lib/shared.ts';
  import { pairStreams } from '#lib/streams/pairStreams.ts';

  let { job, caption }: { job: JobDetail; caption: string } = $props();
</script>

<StreamCompare
  {caption}
  rows={pairStreams({ before: job.before, plan: job.plan, after: job.after })}
  afterLabel={job.after ? 'After' : 'Planned'}
/>
