import { expect, test } from 'bun:test';
import { restartTarget } from './restartTarget.ts';

const page = (href: string) => new URL(href);

test('restartTarget - unchanged settings keep the page origin and base', () => {
  expect(
    restartTarget(page('http://nas:8585/settings/general'), { port: 8585, runningPort: 8585, urlBase: '' }),
  ).toEqual({
    origin: 'http://nas:8585',
    urlBase: '',
  });
});

test('restartTarget - a new URL base is used, not the one the page was loaded with', () => {
  expect(
    restartTarget(page('http://nas:8585/settings/general'), { port: 8585, runningPort: 8585, urlBase: '/wololo' }),
  ).toEqual({ origin: 'http://nas:8585', urlBase: '/wololo' });
  expect(
    restartTarget(page('http://nas:8585/wololo/settings/general'), { port: 8585, runningPort: 8585, urlBase: '' }),
  ).toEqual({ origin: 'http://nas:8585', urlBase: '' });
});

test('restartTarget - a new port moves a direct connection to that port', () => {
  expect(restartTarget(page('http://192.168.1.5:8585/'), { port: 9090, runningPort: 8585, urlBase: '' })).toEqual({
    origin: 'http://192.168.1.5:9090',
    urlBase: '',
  });
});

test('restartTarget - a direct connection on the default port moves to the new port', () => {
  expect(restartTarget(page('http://nas/'), { port: 9090, runningPort: 80, urlBase: '' }).origin).toBe(
    'http://nas:9090',
  );
});

test('restartTarget - behind a reverse proxy a new port keeps the proxy address', () => {
  expect(
    restartTarget(page('https://wololo.example.com/'), { port: 9090, runningPort: 8585, urlBase: '' }).origin,
  ).toBe('https://wololo.example.com');
});
