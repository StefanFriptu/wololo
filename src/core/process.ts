export interface LowPriority {
  niceLevel: number;
  ioniceClass: 'idle' | 'best-effort';
}

export interface PriorityTools {
  nice: string | null;
  ionice: string | null;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Wrap with ionice/nice when available. Jobs pass the processing settings; probes may pass false. */
  lowPriority?: LowPriority | false;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Bytes of stdout kept in RunResult.stdout. Default 16 MiB (ffprobe JSON of large files). */
  maxStdoutBytes?: number;
  /** Bytes of stderr tail kept in RunResult.stderr. Default 64 KiB. */
  maxStderrBytes?: number;
}

export interface RunResult {
  argv: string[];
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  aborted: boolean;
  timedOut: boolean;
}

let cachedPriorityTools: PriorityTools | null = null;

export function priorityTools(): PriorityTools {
  cachedPriorityTools ??= {
    nice: Bun.which('nice'),
    ionice: Bun.which('ionice'),
  };
  return cachedPriorityTools;
}

export function findExecutable(name: string): string | null {
  return Bun.which(name);
}

/** Prefixes argv with ionice and nice when the tools exist (ionice is Linux only). */
export function withLowPriority(
  argv: string[],
  priority: LowPriority,
  tools: PriorityTools,
): string[] {
  const prefix: string[] = [];
  if (tools.ionice) {
    prefix.push(
      tools.ionice,
      '-c',
      priority.ioniceClass === 'idle' ? '3' : '2',
    );
    if (priority.ioniceClass === 'best-effort') prefix.push('-n', '7');
  }
  if (tools.nice) prefix.push(tools.nice, '-n', String(priority.niceLevel));
  return [...prefix, ...argv];
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  keep: 'head' | 'tail',
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let captured = '';
  let partial = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (keep === 'head') {
      if (captured.length < maxBytes)
        captured += text.slice(0, maxBytes - captured.length);
    } else {
      captured = (captured + text).slice(-maxBytes);
    }
    if (onLine) {
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  }
  const rest = decoder.decode();
  if (rest)
    captured =
      keep === 'head'
        ? (captured + rest).slice(0, maxBytes)
        : (captured + rest).slice(-maxBytes);
  if (onLine && (partial || rest)) onLine(partial + rest);
  return captured;
}

/** Spawns a child process, streams its output line by line, and resolves when it exits (never rejects on exit code). */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  const base = [options.command, ...options.args];
  const argv = options.lowPriority
    ? withLowPriority(base, options.lowPriority, priorityTools())
    : base;
  const started = performance.now();
  let timedOut = false;

  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const kill = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000).unref?.();
  };
  const onAbort = () => kill();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) kill();
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs)
    : null;

  try {
    const [stdout, stderr] = await Promise.all([
      pumpLines(
        child.stdout,
        options.maxStdoutBytes ?? 16 * 1024 * 1024,
        'head',
        options.onStdoutLine,
      ),
      pumpLines(
        child.stderr,
        options.maxStderrBytes ?? 64 * 1024,
        'tail',
        options.onStderrLine,
      ),
    ]);
    await child.exited;
    return {
      argv,
      exitCode: child.exitCode,
      signalCode: child.signalCode == null ? null : String(child.signalCode),
      stdout,
      stderr,
      durationMs: Math.round(performance.now() - started),
      aborted: options.signal?.aborted ?? false,
      timedOut,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
