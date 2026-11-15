import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  DEFAULT_PORT,
  isValidBindAddress,
  isValidUrlBase,
  loopbackHost,
  normalizeUrlBase,
  resolveAppVersion,
  resolveBootSettings,
} from '../../src/core/config.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-config-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  test('creates config.json with defaults and a generated API key on first start', () => {
    const dir = tempDir();
    const config = new ConfigStore({ configDir: dir, env: {} }).get();
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.apiKey).toMatch(/^[0-9a-f]{32}$/);
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(stored.apiKey).toBe(config.apiKey);
    expect(new ConfigStore({ configDir: dir, env: {} }).get().apiKey).toBe(config.apiKey);
  });

  test('env vars override the file and are reported as locked', () => {
    const config = new ConfigStore({
      configDir: tempDir(),
      env: {
        WOLOLO__PORT: '9000',
        WOLOLO__URL_BASE: 'wololo/',
        WOLOLO__LOG_LEVEL: 'debug',
      },
    }).get();
    expect(config.port).toBe(9000);
    expect(config.urlBase).toBe('/wololo');
    expect(config.logLevel).toBe('debug');
    expect(config.envOverrides.sort()).toEqual(['logLevel', 'port', 'urlBase']);
  });

  test('update persists and regenerateApiKey changes the key', () => {
    const store = new ConfigStore({ configDir: tempDir(), env: {} });
    const before = store.get().apiKey;
    expect(store.update({ instanceName: 'Pi' }).instanceName).toBe('Pi');
    expect(store.regenerateApiKey().apiKey).not.toBe(before);
    expect(store.get().instanceName).toBe('Pi');
  });

  test.each([
    ['', ''],
    ['/', ''],
    ['wololo', '/wololo'],
    ['/a/b/', '/a/b'],
  ])('normalizeUrlBase(%p) -> %p', (input, expected) => {
    expect(normalizeUrlBase(input)).toBe(expected);
  });

  test.each([
    ['partial file', '{"port":9000}'],
    ['corrupt file', '{not json'],
    ['short key', '{"apiKey":"mykey"}'],
    ['array', '[]'],
  ])('%s gets repaired so the API key is stable across boots', (_name, content) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), content);
    const first = new ConfigStore({ configDir: dir, env: {} }).get();
    const second = new ConfigStore({ configDir: dir, env: {} }).get();
    expect(second.apiKey).toBe(first.apiKey);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).apiKey).toBe(first.apiKey);
    if (content === '{"port":9000}') expect(first.port).toBe(9000);
    if (content === '{not json') expect(existsSync(join(dir, 'config.json.bad'))).toBe(true);
    if (content !== '{"port":9000}') expect(first.warnings.length).toBeGreaterThan(0);
  });

  test('invalid env values are ignored, reported and not marked as locked', () => {
    const config = new ConfigStore({
      configDir: tempDir(),
      env: { WOLOLO__PORT: 'abc', WOLOLO__API_KEY: 'short', WOLOLO__LOG_LEVEL: 'warn', WOLOLO__URL_BASE: '' },
    }).get();
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.envOverrides).toEqual(['logLevel']);
    expect(config.warnings).toEqual([
      'WOLOLO__PORT is invalid and was ignored',
      'WOLOLO__API_KEY is invalid and was ignored',
    ]);
  });

  test('resolveBootSettings reads without writing and applies env like the store', () => {
    const dir = tempDir();
    expect(resolveBootSettings({ WOLOLO__URL_BASE: 'wololo/', WOLOLO__PORT: '' }, dir)).toEqual({
      port: DEFAULT_PORT,
      bindAddress: '*',
      urlBase: '/wololo',
    });
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    writeFileSync(join(dir, 'config.json'), '{"port":9001,"bindAddress":"192.168.1.2"}');
    expect(resolveBootSettings({}, dir)).toEqual({ port: 9001, bindAddress: '192.168.1.2', urlBase: '' });
  });
});

test.each([
  ['*', true],
  ['0.0.0.0', true],
  ['192.168.1.2', true],
  ['::', true],
  ['not a host', false],
  ['localhost', false],
])('isValidBindAddress(%p) -> %p', (value, expected) => {
  expect(isValidBindAddress(value)).toBe(expected);
});

test.each([
  ['', true],
  ['/wololo', true],
  ['wololo/', true],
  ['/a/b-c_d.e~f', true],
  ['/:x', false],
  ['/a b', false],
  ['/a?b', false],
])('isValidUrlBase(%p) -> %p', (value, expected) => {
  expect(isValidUrlBase(value)).toBe(expected);
});

test.each([
  ['*', '127.0.0.1'],
  ['0.0.0.0', '127.0.0.1'],
  ['::', '[::1]'],
  ['192.168.1.2', '192.168.1.2'],
  ['fd00::2', '[fd00::2]'],
])('loopbackHost(%p) -> %p', (bind, expected) => {
  expect(loopbackHost(bind)).toBe(expected);
});

test.each([
  [{ WOLOLO_VERSION: '1.2.0' }, '1.2.0'],
  [{ WOLOLO_VERSION: 'dev' }, '0.1.0'],
  [{ WOLOLO_VERSION: '' }, '0.1.0'],
  [{}, '0.1.0'],
])('resolveAppVersion(%p) -> %p', (env, expected) => {
  expect(resolveAppVersion(env, '0.1.0')).toBe(expected);
});
