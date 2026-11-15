<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Connect"
  milestone="M3"
  description="Radarr and Sonarr instances, path mappings and the webhook URL to paste into Settings > Connect > Webhook."
  endpoints={["GET /api/v1/arr", "POST /api/v1/arr", "POST /api/v1/arr/test", "GET /api/v1/pathmappings"]}
/>
