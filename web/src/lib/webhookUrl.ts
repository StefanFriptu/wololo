import type { ArrKind } from '#lib/shared.ts';

export interface WebhookUrlInput {
  origin: string;
  urlBase: string;
  kind: ArrKind;
  instanceId: number;
  apiKey: string;
}

/** URL to paste into Radarr/Sonarr Settings > Connect > Webhook. */
export function webhookUrl({ origin, urlBase, kind, instanceId, apiKey }: WebhookUrlInput): string {
  const query = new URLSearchParams({ instance: String(instanceId), apikey: apiKey });
  return `${origin.replace(/\/+$/, '')}${urlBase}/api/v1/webhook/${kind}?${query}`;
}
