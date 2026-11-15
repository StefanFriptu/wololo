<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="File detail"
  milestone="M5"
  description="Streams before and after, side by side, with what changed and what was lost."
  endpoints={["GET /api/v1/media/:id", "GET /api/v1/media/:id/plan", "POST /api/v1/media/:id/probe", "PUT /api/v1/media/:id/ignore", "POST /api/v1/jobs"]}
/>
