<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Job"
  milestone="M5"
  description="One job: plan, before/after streams, verification checks and the full ffmpeg/mkvmerge log."
  endpoints={["GET /api/v1/jobs/:id", "GET /api/v1/jobs/:id/log", "POST /api/v1/jobs/:id/retry"]}
/>
