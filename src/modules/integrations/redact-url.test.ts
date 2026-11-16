import { expect, test } from 'bun:test';
import { redactUrl } from './redact-url.ts';

test('redactUrl - hides userinfo', () => {
  expect(redactUrl('http://admin:hunter2@qbit.lan:8080/base')).toBe('http://***:***@qbit.lan:8080/base');
});

test('redactUrl - hides a user without a password', () => {
  expect(redactUrl('https://token@plex.lan:32400')).toBe('https://***@plex.lan:32400/');
});

test('redactUrl - a URL without userinfo is unchanged', () => {
  expect(redactUrl('http://radarr:7878')).toBe('http://radarr:7878');
});

test('redactUrl - unparseable input is unchanged', () => {
  expect(redactUrl('not a url')).toBe('not a url');
});
