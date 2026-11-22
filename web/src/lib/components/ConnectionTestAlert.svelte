<script lang="ts">
  import type { ConnectionTestResult } from '#lib/shared.ts';

  let { result }: { result: ConnectionTestResult } = $props();
</script>

<p class="alert tone-{result.ok ? 'success' : 'danger'}" role="status">
  {result.message}{result.version ? ` (version ${result.version})` : ''}
</p>
