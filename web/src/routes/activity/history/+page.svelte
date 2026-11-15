<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="History"
  milestone="M5"
  description="Finished jobs and file events, including lost-feature notes and recycle-bin actions."
  endpoints={["GET /api/v1/history", "GET /api/v1/jobs", "GET /api/v1/recyclebin"]}
/>
