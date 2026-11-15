<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Tasks"
  milestone="M1"
  description="Scheduled tasks (library scan every 6 hours, recycle bin purge, backup) with last and next run."
  endpoints={["GET /api/v1/system/tasks", "POST /api/v1/system/tasks/:name/run", "PUT /api/v1/system/tasks/:name"]}
/>
