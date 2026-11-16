import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(import.meta.dir, 'entrypoint.sh');
const root = mkdtempSync(join(tmpdir(), 'wololo-entrypoint-'));

afterAll(() => {
  chmodSync(join(root, 'read-only'), 0o755);
  rmSync(root, { recursive: true, force: true });
});

function runEntrypoint(configDir: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['sh', ENTRYPOINT, 'echo', 'started'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', WOLOLO_CONFIG_DIR: configDir },
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const runningAsRoot = process.getuid?.() === 0;

test.skipIf(runningAsRoot)('entrypoint - a writable config dir starts the command', () => {
  const writable = join(root, 'writable');
  mkdirSync(writable);
  const run = runEntrypoint(writable);
  expect(run.stderr).toBe('');
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain('started');
});

test.skipIf(runningAsRoot)('entrypoint - a non-writable config dir stops with an actionable message', () => {
  const readOnly = join(root, 'read-only');
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o555);
  const run = runEntrypoint(readOnly);
  expect(run.exitCode).toBe(1);
  expect(run.stdout).not.toContain('started');
  expect(run.stderr).toContain(`Wololo: ${readOnly} is not writable by`);
  expect(run.stderr).toContain('chown it on the host');
});
