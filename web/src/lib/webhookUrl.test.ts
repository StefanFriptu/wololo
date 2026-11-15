import { expect, test } from 'bun:test';
import { webhookUrl } from './webhookUrl.ts';

test('webhookUrl - builds the Radarr URL with instance and key', () => {
  expect(
    webhookUrl({ origin: 'http://192.168.1.5:8585', urlBase: '', kind: 'radarr', instanceId: 2, apiKey: 'abc123' }),
  ).toBe('http://192.168.1.5:8585/api/v1/webhook/radarr?instance=2&apikey=abc123');
});

test('webhookUrl - keeps the URL base and drops a trailing slash on the origin', () => {
  expect(
    webhookUrl({ origin: 'https://home.example/', urlBase: '/wololo', kind: 'sonarr', instanceId: 7, apiKey: 'k' }),
  ).toBe('https://home.example/wololo/api/v1/webhook/sonarr?instance=7&apikey=k');
});

test('webhookUrl - encodes unusual key characters', () => {
  expect(webhookUrl({ origin: 'http://h', urlBase: '', kind: 'radarr', instanceId: 1, apiKey: 'a+b&c' })).toBe(
    'http://h/api/v1/webhook/radarr?instance=1&apikey=a%2Bb%26c',
  );
});
