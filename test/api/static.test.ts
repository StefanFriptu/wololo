import { expect, test } from 'bun:test';
import { applyUrlBase, isLocalAddress, shouldExposeApiKey } from '../../src/api/static.ts';

test.each([
  ['127.0.0.1', true],
  ['10.1.2.3', true],
  ['172.16.0.1', true],
  ['172.31.255.255', true],
  ['172.32.0.1', false],
  ['192.168.1.20', true],
  ['100.64.0.1', true],
  ['169.254.1.1', true],
  ['::ffff:192.168.1.5', true],
  ['::1', true],
  ['fd12:3456::1', true],
  ['fe80::1', true],
  ['8.8.8.8', false],
  ['2001:db8::1', false],
  ['not-an-ip', false],
])('isLocalAddress(%p) -> %p', (address, expected) => {
  expect(isLocalAddress(address)).toBe(expected);
});

test.each([
  ['disabled', '8.8.8.8', true, true],
  ['required', '127.0.0.1', false, false],
  ['disabled_for_local_addresses', '192.168.1.5', false, true],
  ['disabled_for_local_addresses', '192.168.1.5', true, false],
  ['disabled_for_local_addresses', '8.8.8.8', false, false],
  ['disabled_for_local_addresses', null, false, false],
] as const)('shouldExposeApiKey(%p, %p, proxied=%p) -> %p', (mode, address, proxied, expected) => {
  expect(shouldExposeApiKey(mode, address, proxied)).toBe(expected);
});

test('applyUrlBase leaves the template alone without a base', () => {
  const html = '<link href="/_app/x.js"><script>{ base: "" }</script>';
  expect(applyUrlBase(html, '')).toBe(html);
});

test('applyUrlBase prefixes root-absolute references only', () => {
  const html =
    '<a href="https://x.org/"></a><link href="//cdn/x"><link href="/favicon.svg"><script>import("/_app/a.js"); x = { base: "" };</script>';
  expect(applyUrlBase(html, '/wololo')).toBe(
    '<a href="https://x.org/"></a><link href="//cdn/x"><link href="/wololo/favicon.svg"><script>import("/wololo/_app/a.js"); x = { base: "/wololo" };</script>',
  );
});
