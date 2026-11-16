import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './bootstrap.ts';

test('start - a failed bind names the address, the config file and the env overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-bootstrap-'));
  const taken = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const runtime = createRuntime({
    env: { WOLOLO_WEB_DIR: join(dir, 'no-web'), WOLOLO__BIND_ADDRESS: '127.0.0.1' },
    configDir: join(dir, 'config'),
    port: taken.port,
    console: false,
  });
  try {
    const failure = await runtime.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`cannot listen on 127.0.0.1:${taken.port}`);
    expect(message).toContain(join(dir, 'config', 'config.json'));
    expect(message).toContain('WOLOLO__PORT');
    expect(message).toContain('WOLOLO__BIND_ADDRESS');
    expect(runtime.ctx.logs.entries({ module: 'bootstrap', level: 'error' }).map((entry) => entry.message)).toContain(
      message,
    );
  } finally {
    await runtime.stop('test');
    await taken.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
