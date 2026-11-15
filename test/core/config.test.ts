import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  DEFAULT_PORT,
  normalizeUrlBase,
} from '../../src/core/config.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-config-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  test('creates config.json with defaults and a generated API key on first start', () => {
    const dir = tempDir();
    const config = new ConfigStore({ configDir: dir, env: {} }).get();
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.apiKey).toMatch(/^[0-9a-f]{32}$/);
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(stored.apiKey).toBe(config.apiKey);
    expect(new ConfigStore({ configDir: dir, env: {} }).get().apiKey).toBe(
      config.apiKey,
    );
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
});
