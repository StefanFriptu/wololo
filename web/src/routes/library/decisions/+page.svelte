<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Decisions"
  milestone="M4"
  description="BDMV discs waiting for a choice: ambiguous main title (theatrical vs extended) or a low Radarr match score."
  endpoints={["GET /api/v1/bdmv/decisions", "POST /api/v1/bdmv/decisions/:id/resolve", "POST /api/v1/bdmv/decisions/:id/dismiss"]}
/>
