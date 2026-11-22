import { expect, test } from 'bun:test';
import type { ArrNotification } from './arr-client.ts';
import { isWololoWebhook, notificationField, notificationTestMessage, wololoWebhook } from './webhook-notification.ts';

const webhook = (url: string, extra: Partial<ArrNotification> = {}): ArrNotification => ({
  id: 3,
  name: 'Mine',
  implementation: 'Webhook',
  fields: [{ name: 'url', value: url }],
  ...extra,
});

const TARGET = { kind: 'sonarr', instanceId: 2 } as const;

test('isWololoWebhook - matches the webhook path and instance on any host', () => {
  expect(isWololoWebhook(webhook('http://10.0.0.5:8585/api/v1/webhook/sonarr?instance=2&apikey=x'), TARGET)).toBe(true);
  expect(isWololoWebhook(webhook('https://proxy/wololo/api/v1/webhook/sonarr/?instance=2'), TARGET)).toBe(true);
});

test('isWololoWebhook - another instance, kind or implementation does not match', () => {
  expect(isWololoWebhook(webhook('http://w/api/v1/webhook/sonarr?instance=3'), TARGET)).toBe(false);
  expect(isWololoWebhook(webhook('http://w/api/v1/webhook/radarr?instance=2'), TARGET)).toBe(false);
  expect(
    isWololoWebhook(webhook('http://w/api/v1/webhook/sonarr?instance=2', { implementation: 'Discord' }), TARGET),
  ).toBe(false);
});

test('isWololoWebhook - an unparsable or missing URL does not match', () => {
  expect(isWololoWebhook(webhook('not a url'), TARGET)).toBe(false);
  expect(isWololoWebhook({ implementation: 'Webhook', fields: [] }, TARGET)).toBe(false);
});

test('wololoWebhook - a template gets the name, triggers, POST and URL, keeping other fields', () => {
  const template: ArrNotification = {
    implementation: 'Webhook',
    onGrab: false,
    fields: [
      { name: 'url', value: '' },
      { name: 'method', value: 2 },
      { name: 'username', value: '' },
    ],
  };
  const result = wololoWebhook(template, 'http://w/hook');
  expect(result).toMatchObject({ name: 'Wololo', onDownload: true, onUpgrade: true, onGrab: false });
  expect(notificationField(result, 'url')).toBe('http://w/hook');
  expect(notificationField(result, 'method')).toBe(1);
  expect(notificationField(result, 'username')).toBe('');
});

test('wololoWebhook - an existing entry keeps its id and name', () => {
  const result = wololoWebhook(webhook('http://old/hook'), 'http://new/hook');
  expect(result).toMatchObject({ id: 3, name: 'Mine' });
  expect(notificationField(result, 'url')).toBe('http://new/hook');
});

test('wololoWebhook - adds url and method when the template lacks them', () => {
  const result = wololoWebhook({ implementation: 'Webhook', fields: [] }, 'http://w/hook');
  expect(notificationField(result, 'url')).toBe('http://w/hook');
  expect(notificationField(result, 'method')).toBe(1);
});

test('notificationTestMessage - joins the validation messages', () => {
  const body = JSON.stringify([
    { propertyName: 'Url', errorMessage: 'Unable to send test message: Connection refused (localhost:8585)' },
  ]);
  expect(notificationTestMessage(body)).toBe('Unable to send test message: Connection refused (localhost:8585)');
});

test('notificationTestMessage - null for empty, non-JSON or unexpected bodies', () => {
  expect(notificationTestMessage(null)).toBeNull();
  expect(notificationTestMessage('<html>')).toBeNull();
  expect(notificationTestMessage('{"message":"x"}')).toBeNull();
});
