<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Edit profile"
  milestone="M1"
  description="Allowed audio, video and subtitle codecs, target codec, bitrates and Dolby Vision handling."
  endpoints={["GET /api/v1/profiles/:id", "PUT /api/v1/profiles/:id", "DELETE /api/v1/profiles/:id"]}
/>
