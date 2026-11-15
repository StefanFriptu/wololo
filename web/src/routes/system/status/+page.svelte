<script lang="ts">
  import Placeholder from '#lib/components/Placeholder.svelte';
</script>

<Placeholder
  title="Status"
  milestone="M0 / platform"
  description="Version, runtime, paths, tool availability (ffmpeg, ffprobe, mkvmerge) and health warnings."
  endpoints={["GET /api/v1/system/status", "GET /api/v1/system/health"]}
/>
