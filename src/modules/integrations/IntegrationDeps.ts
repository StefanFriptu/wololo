import type { FetchLike } from './upstream.ts';

export interface IntegrationDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}
