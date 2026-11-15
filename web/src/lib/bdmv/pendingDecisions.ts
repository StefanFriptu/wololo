import { api } from '#lib/api/client.ts';
import { Resource } from '#lib/resource.svelte.ts';

export const pendingDecisions = new Resource((signal) =>
  api('GET /api/v1/bdmv/decisions', { query: { state: 'pending' }, signal }),
);
