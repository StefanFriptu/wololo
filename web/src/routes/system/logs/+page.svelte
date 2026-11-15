<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Logs"
  milestone="M5"
  description="Recent log entries and log files."
  endpoints={["GET /api/v1/system/logs", "GET /api/v1/system/logs/files", "GET /api/v1/system/logs/files/:name"]}
/>
