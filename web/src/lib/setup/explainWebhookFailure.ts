import { isLoopbackAddress } from '#lib/webhookAddress.ts';

interface WebhookFailure {
  service: string;
  address: string;
  message: string;
}

/** A plain next step for a failed webhook test, or null when the message is all there is to say. */
export function explainWebhookFailure({ service, address, message }: WebhookFailure): string | null {
  if (isLoopbackAddress(address)) {
    return `${service} tried ${address}. Inside Docker that points at ${service} itself. Use the host's address or Wololo's container name.`;
  }
  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return `Wololo refused the API key in the webhook URL. Add the webhook again so it carries the current key.`;
  }
  if (/refused|timed out|timeout|unreachable|no route|resolve|name or service not known|nodename/i.test(message)) {
    return `${service} cannot reach ${address}. Check the address, and that Wololo's port is open to ${service}.`;
  }
  return null;
}
