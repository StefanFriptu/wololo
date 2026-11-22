import { api } from '#lib/api/client.ts';
import { Resource } from '#lib/resource.svelte.ts';
import type { Settings } from '#lib/shared.ts';

type SetupProgress = Settings['setup'];

export const setupProgress = new Resource<SetupProgress>((signal) =>
  api('GET /api/v1/settings', { signal }).then((settings) => settings.setup),
);

export async function saveSetupProgress(patch: Partial<SetupProgress>): Promise<void> {
  const settings = await api('PUT /api/v1/settings', { body: { setup: patch } });
  setupProgress.set(settings.setup);
}
