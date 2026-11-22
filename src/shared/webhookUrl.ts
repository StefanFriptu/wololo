import type { ArrKind } from './domain.ts';
import { trimTrailingSlashes } from './trimTrailingSlashes.ts';

interface WebhookUrlInput {
  origin: string;
  urlBase: string;
  kind: ArrKind;
  instanceId: number;
  apiKey: string;
}

/** URL to paste into Radarr/Sonarr Settings > Connect > Webhook. */
export function webhookUrl({ origin, urlBase, kind, instanceId, apiKey }: WebhookUrlInput): string {
  const query = new URLSearchParams({ instance: String(instanceId), apikey: apiKey });
  return `${trimTrailingSlashes(origin)}${urlBase}/api/v1/webhook/${kind}?${query}`;
}
