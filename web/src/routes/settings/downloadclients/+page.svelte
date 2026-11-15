<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Download clients"
  milestone="M4"
  description="qBittorrent: leave sources alone while they seed, remove them once the ratio or time goal is met."
  endpoints={["GET /api/v1/downloadclient", "PUT /api/v1/downloadclient", "POST /api/v1/downloadclient/test"]}
/>
