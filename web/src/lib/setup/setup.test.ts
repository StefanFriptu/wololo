import { expect, test } from 'bun:test';
import { explainWebhookFailure } from './explainWebhookFailure.ts';
import { adjacentStep } from './setupSteps.ts';
import { shouldOpenSetup } from './shouldOpenSetup.ts';

const FRESH = { completed: false, step: 'welcome', dismissed: false } as const;

test('adjacentStep - moves forward and back', () => {
  expect(adjacentStep('arr', 1)).toBe('plex');
  expect(adjacentStep('arr', -1)).toBe('media');
});

test('adjacentStep - null past either end', () => {
  expect(adjacentStep('welcome', -1)).toBeNull();
  expect(adjacentStep('check', 1)).toBeNull();
});

test('shouldOpenSetup - a fresh install opens the setup', () => {
  expect(shouldOpenSetup({ setup: FRESH, libraryCount: 0, arrCount: 0 })).toBe(true);
});

test('shouldOpenSetup - an install with a library or an instance only gets the banner', () => {
  expect(shouldOpenSetup({ setup: FRESH, libraryCount: 1, arrCount: 0 })).toBe(false);
  expect(shouldOpenSetup({ setup: FRESH, libraryCount: 0, arrCount: 1 })).toBe(false);
});

test('shouldOpenSetup - never after completing or dismissing it', () => {
  expect(shouldOpenSetup({ setup: { ...FRESH, completed: true }, libraryCount: 0, arrCount: 0 })).toBe(false);
  expect(shouldOpenSetup({ setup: { ...FRESH, dismissed: true }, libraryCount: 0, arrCount: 0 })).toBe(false);
});

test('explainWebhookFailure - a loopback address points at the other container', () => {
  expect(
    explainWebhookFailure({ service: 'Radarr', address: 'http://localhost:8585', message: 'Connection refused' }),
  ).toContain('Inside Docker that points at Radarr itself');
});

test('explainWebhookFailure - a rejected key', () => {
  expect(
    explainWebhookFailure({ service: 'Sonarr', address: 'http://10.0.0.2:8585', message: 'Unauthorized (401)' }),
  ).toContain('API key');
});

test('explainWebhookFailure - an unreachable address', () => {
  expect(
    explainWebhookFailure({
      service: 'Sonarr',
      address: 'http://wololo:8585',
      message: 'Unable to send test message: Name or service not known (wololo:8585)',
    }),
  ).toBe("Sonarr cannot reach http://wololo:8585. Check the address, and that Wololo's port is open to Sonarr.");
});

test('explainWebhookFailure - null for anything else', () => {
  expect(explainWebhookFailure({ service: 'Sonarr', address: 'http://10.0.0.2:8585', message: 'HTTP 500' })).toBeNull();
});
