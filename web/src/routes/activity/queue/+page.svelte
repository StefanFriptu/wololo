<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Queue"
  milestone="M2 / M5"
  description="Queued and running jobs with live progress (speed, ETA, current step) over server-sent events."
  endpoints={["GET /api/v1/queue", "POST /api/v1/queue/pause", "POST /api/v1/queue/resume", "POST /api/v1/jobs/:id/cancel", "GET /api/v1/events"]}
/>
