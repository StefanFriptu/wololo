<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Plex"
  milestone="M3"
  description="Sign in with plex.tv, pick the server, partial scans after each change and auto-pause while Plex streams."
  endpoints={["GET /api/v1/plex", "POST /api/v1/plex/pin", "GET /api/v1/plex/servers", "PUT /api/v1/plex"]}
/>
