<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Library"
  milestone="M1 / M5"
  description="Every file in the configured libraries with its status (Compatible, Needs work, Processing, Failed, Ignored) and filters by codec, profile and library."
  endpoints={["GET /api/v1/media", "GET /api/v1/media/stats", "GET /api/v1/libraries", "POST /api/v1/scans"]}
/>
