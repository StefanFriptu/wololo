<script lang="ts">
  import { ApiError } from '#lib/api/ApiError.ts';
  import { auth } from '#lib/api/auth.svelte.ts';
  import { api } from '#lib/api/client.ts';
  import { errorMessage } from '#lib/api/errorMessage.ts';

  let key = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate) return;
    busy = true;
    error = null;
    try {
      await api('GET /api/v1/settings/general', { apiKey: candidate });
      auth.accept(candidate);
    } catch (e) {
      error = e instanceof ApiError && e.status === 401 ? 'That API key was not accepted.' : errorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="prompt">
  <form class="card" onsubmit={submit}>
    <h1>Wololo</h1>
    <p class="muted">Enter the API key to continue. It is shown in Settings > General, in config.json, or set by WOLOLO__API_KEY.</p>
    <label for="api-key">API key</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="api-key" type="password" bind:value={key} autocomplete="current-password" autofocus required />
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <button class="primary" type="submit" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Continue'}</button>
  </form>
</main>

<style>
  .prompt {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  form {
    width: min(24rem, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  h1 {
    color: var(--accent-text);
    margin: 0;
  }
  label {
    font-weight: 600;
  }
  .error {
    color: var(--danger-fg);
    margin: 0;
  }
  button {
    justify-content: center;
  }
</style>
