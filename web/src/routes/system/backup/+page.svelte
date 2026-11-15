<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Backup"
  milestone="platform"
  description="Back up and restore the database and settings."
  endpoints={["GET /api/v1/system/backups", "POST /api/v1/system/backups", "POST /api/v1/system/backups/restore"]}
/>
