<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Dry run"
  milestone="M1"
  description="How many files fail each profile, grouped by codec, with estimated time and disk space. Writes nothing."
  endpoints={["GET /api/v1/dryrun", "POST /api/v1/scans", "GET /api/v1/scans/current"]}
/>
