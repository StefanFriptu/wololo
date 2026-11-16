import { expect, test } from 'bun:test';
import { isLoopbackAddress, loadWebhookAddress, saveWebhookAddress } from './webhookAddress.ts';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    }),
  };
}

const blocked = () => {
  throw new Error('SecurityError');
};

test('loadWebhookAddress - defaults to the browser origin', () => {
  expect(loadWebhookAddress(memoryStorage().storage, 'http://localhost:8585')).toBe('http://localhost:8585');
});

test('saveWebhookAddress - a saved address is loaded again without its trailing slash', () => {
  const { storage } = memoryStorage();
  saveWebhookAddress(storage, ' http://wololo:8585/ ', 'http://localhost:8585');
  expect(loadWebhookAddress(storage, 'http://localhost:8585')).toBe('http://wololo:8585');
});

test('saveWebhookAddress - empty or the origin itself forgets the saved address', () => {
  const { storage, items } = memoryStorage();
  saveWebhookAddress(storage, 'http://wololo:8585', 'http://localhost:8585');
  expect(items.size).toBe(1);
  saveWebhookAddress(storage, '', 'http://localhost:8585');
  expect(items.size).toBe(0);
  saveWebhookAddress(storage, 'http://wololo:8585', 'http://localhost:8585');
  saveWebhookAddress(storage, 'http://localhost:8585', 'http://localhost:8585');
  expect(items.size).toBe(0);
});

test('webhookAddress - blocked storage falls back to the origin and does not throw', () => {
  expect(loadWebhookAddress(blocked, 'http://192.168.1.5:8585')).toBe('http://192.168.1.5:8585');
  expect(() => saveWebhookAddress(blocked, 'http://wololo:8585', 'http://192.168.1.5:8585')).not.toThrow();
});

test.each([
  ['http://localhost:8585', true],
  ['http://127.0.0.1:8585', true],
  ['http://[::1]:8585', true],
  ['http://wololo:8585', false],
  ['http://192.168.1.5:8585', false],
  ['not a url', false],
])('isLoopbackAddress - %p is %p', (address, expected) => {
  expect(isLoopbackAddress(address)).toBe(expected);
});
