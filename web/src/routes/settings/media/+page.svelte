<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Media"
  milestone="M1"
  description="Libraries and root folders, per-library mode (Replace or Keep both), language keep-list, processing window and recycle bin."
  endpoints={["GET /api/v1/libraries", "POST /api/v1/libraries", "GET /api/v1/filesystem", "GET /api/v1/settings", "PUT /api/v1/settings"]}
/>
