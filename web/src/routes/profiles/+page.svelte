<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Profiles"
  milestone="M1"
  description="Device profiles: codecs each TV decodes plus the target codec. Clone the Samsung Tizen default and edit it per device."
  endpoints={["GET /api/v1/profiles", "POST /api/v1/profiles", "POST /api/v1/profiles/:id/clone", "GET /api/v1/profiles/codecs"]}
/>
