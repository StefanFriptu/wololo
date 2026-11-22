import type { ArrKind } from '../../shared/domain.ts';
import type { ArrNotification } from './arr-client.ts';

const WEBHOOK_NAME = 'Wololo';
const WEBHOOK_IMPLEMENTATION = 'Webhook';
/** Radarr/Sonarr WebhookMethod.POST. */
const METHOD_POST = 1;

interface WebhookTarget {
  kind: ArrKind;
  instanceId: number;
}

export function notificationField(notification: ArrNotification, name: string): unknown {
  return notification.fields.find((field) => field.name.toLowerCase() === name.toLowerCase())?.value;
}

export function isWebhookTemplate(notification: ArrNotification): boolean {
  return notification.implementation === WEBHOOK_IMPLEMENTATION;
}

/** A Webhook entry whose URL points at Wololo's webhook for this instance, whatever host it uses. */
export function isWololoWebhook(notification: ArrNotification, target: WebhookTarget): boolean {
  if (!isWebhookTemplate(notification)) return false;
  const value = notificationField(notification, 'url');
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.pathname.replace(/\/+$/, '').endsWith(`/api/v1/webhook/${target.kind}`) &&
      url.searchParams.get('instance') === String(target.instanceId)
    );
  } catch {
    return false;
  }
}

/** The entry (a schema template or the existing one) set up as Wololo's: POST to url on import and upgrade. */
export function wololoWebhook(base: ArrNotification, url: string): ArrNotification {
  const known = new Set(base.fields.map((field) => field.name.toLowerCase()));
  const fields = base.fields.map((field) => {
    const name = field.name.toLowerCase();
    if (name === 'url') return { ...field, value: url };
    if (name === 'method') return { ...field, value: METHOD_POST };
    return field;
  });
  if (!known.has('url')) fields.push({ name: 'url', value: url });
  if (!known.has('method')) fields.push({ name: 'method', value: METHOD_POST });
  return {
    ...base,
    name: base.id == null ? WEBHOOK_NAME : base.name || WEBHOOK_NAME,
    implementation: WEBHOOK_IMPLEMENTATION,
    configContract: 'WebhookSettings',
    onDownload: true,
    onUpgrade: true,
    fields,
  };
}

/** Radarr/Sonarr explain a failed notification test as validation failures: [{ errorMessage }]. */
export function notificationTestMessage(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const messages = list.flatMap((entry) =>
      typeof entry === 'object' && entry !== null && 'errorMessage' in entry && typeof entry.errorMessage === 'string'
        ? [entry.errorMessage]
        : [],
    );
    return messages.length > 0 ? messages.join('; ') : null;
  } catch {
    return null;
  }
}
