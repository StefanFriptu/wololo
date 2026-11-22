import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { createRuntime, type Runtime } from '../../src/app/bootstrap.ts';

const ROOT = join(import.meta.dir, '..', '..');

export type ApiCall = <T>(path: string, init?: RequestInit & { json?: unknown }, status?: number) => Promise<T>;

/** fetch with the API key; throws with method, path and body when the status differs from the expected one. */
export function apiClient(base: () => string, apiKey: () => string): ApiCall {
  return async <T>(path: string, init: RequestInit & { json?: unknown } = {}, status = 200): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has('x-api-key')) headers.set('x-api-key', apiKey());
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    const body = init.json === undefined ? init.body : JSON.stringify(init.json);
    const response = await fetch(`${base()}${path}`, { ...init, body, headers });
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`${init.method ?? 'GET'} ${path}: expected ${status}, got ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** Polls `read` until `done` holds; the error names the attempts, the elapsed time and the last value. */
export async function eventually<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const started = Date.now();
  let attempts = 0;
  let last: T;
  do {
    attempts += 1;
    last = await read();
    if (done(last)) return last;
    await Bun.sleep(100);
  } while (Date.now() - started < timeoutMs);
  throw new Error(
    `${what}: not reached after ${attempts} attempts in ${Date.now() - started} ms: ${JSON.stringify(last).slice(0, 2000)}`,
  );
}

export interface InProcessServer {
  runtime: Runtime;
  base: string;
  apiKey: string;
}

/** createRuntime on an ephemeral port with every real service, no web build and no console output. */
export async function startInProcessServer(dir: string, env: Record<string, string> = {}): Promise<InProcessServer> {
  const runtime = createRuntime({
    env: { WOLOLO_WEB_DIR: join(dir, 'no-web'), ...env },
    configDir: join(dir, 'config'),
    port: 0,
    console: false,
  });
  const server = await runtime.start();
  return { runtime, base: `http://127.0.0.1:${server.port}`, apiKey: runtime.ctx.config.get().apiKey };
}

export interface ChildServer {
  base: string;
  process: Subprocess;
  /** Resolves with the exit code. */
  kill(signal: 'SIGKILL' | 'SIGTERM'): Promise<number | null>;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

/** `bun src/index.ts` as a child process (for crash tests); resolves once /health answers. */
export async function startChildServer(configDir: string, env: Record<string, string> = {}): Promise<ChildServer> {
  const port = await freePort();
  const child = Bun.spawn(['bun', join(ROOT, 'src', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WOLOLO_CONFIG_DIR: configDir,
      WOLOLO__PORT: String(port),
      WOLOLO__BIND_ADDRESS: '127.0.0.1',
      WOLOLO_WEB_DIR: join(configDir, 'no-web'),
      ...env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await eventually(
    `child server on ${base}`,
    () =>
      fetch(`${base}/health`)
        .then((response) => response.ok)
        .catch(() => child.exitCode !== null),
    Boolean,
    30_000,
  );
  if (child.exitCode !== null) throw new Error(`child server exited with ${child.exitCode}`);
  return {
    base,
    process: child,
    kill: async (signal) => {
      child.kill(signal);
      await child.exited;
      return child.exitCode;
    },
  };
}

/** `inputArgs` go right before the path (for input options such as `-playlist 800`). */
export async function ffprobeJson<T>(path: string, inputArgs: readonly string[] = []): Promise<T> {
  const proc = Bun.spawn([
    'ffprobe',
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of',
    'json',
    ...inputArgs,
    path,
  ]);
  return JSON.parse(await new Response(proc.stdout).text()) as T;
}

/** MD5 of one stream's packets (`-f streamhash`), the same check the job verification uses for video. */
export async function streamHash(path: string, selector = 'v:0'): Promise<string> {
  const proc = Bun.spawn([
    'ffmpeg',
    '-v',
    'error',
    '-i',
    path,
    '-map',
    `0:${selector}`,
    '-c',
    'copy',
    '-f',
    'streamhash',
    '-hash',
    'md5',
    '-',
  ]);
  return (await new Response(proc.stdout).text()).trim();
}
