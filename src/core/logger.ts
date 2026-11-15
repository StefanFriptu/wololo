import {
  appendFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, LogLevel } from '../shared/domain.ts';

export type LogData = Record<string, unknown>;

export interface Logger {
  trace(message: string, data?: LogData): void;
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
  child(module: string): Logger;
}

export interface LogQueryOptions {
  level?: LogLevel;
  module?: string;
  afterId?: number;
  limit?: number;
}

export interface LogHubOptions {
  level: LogLevel;
  /** Directory for wololo.txt and its rotations; null disables file output (tests). */
  logDir: string | null;
  console?: boolean;
  ringSize?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};
const LOG_FILE = 'wololo.txt';
const FLUSH_INTERVAL_MS = 500;

function serializeError(value: unknown): unknown {
  return value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value;
}

function normalizeData(data?: LogData): LogData | undefined {
  if (!data) return undefined;
  const out: LogData = {};
  for (const [key, value] of Object.entries(data))
    out[key] = serializeError(value);
  return out;
}

export function formatLogLine(entry: LogEntry): string {
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  return `${entry.time}|${entry.level.toUpperCase()}|${entry.module}|${entry.message}${data}`;
}

/** Owns the ring buffer, the rotating log file and listeners; hands out per-module loggers. */
export class LogHub {
  private level: LogLevel;
  private readonly ring: LogEntry[] = [];
  private readonly ringSize: number;
  private readonly logDir: string | null;
  private readonly toConsole: boolean;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private pending: string[] = [];
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LogHubOptions) {
    this.level = options.level;
    this.logDir = options.logDir;
    this.toConsole = options.console ?? true;
    this.ringSize = options.ringSize ?? 1000;
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    if (this.logDir) {
      this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  logger(module: string): Logger {
    const write = (level: LogLevel) => (message: string, data?: LogData) =>
      this.write(level, module, message, data);
    return {
      trace: write('trace'),
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (child) => this.logger(`${module}.${child}`),
    };
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entries(query: LogQueryOptions = {}): LogEntry[] {
    const minRank = LEVEL_RANK[query.level ?? 'trace'];
    const limit = Math.min(Math.max(query.limit ?? 200, 1), this.ringSize);
    const matches = this.ring.filter(
      (entry) =>
        LEVEL_RANK[entry.level] >= minRank &&
        (query.afterId === undefined || entry.id > query.afterId) &&
        (query.module === undefined ||
          entry.module === query.module ||
          entry.module.startsWith(`${query.module}.`)),
    );
    return matches.slice(-limit).reverse();
  }

  listFiles(): {
    name: string;
    path: string;
    sizeBytes: number;
    modifiedAt: string;
  }[] {
    if (!this.logDir || !existsSync(this.logDir)) return [];
    return readdirSync(this.logDir)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => {
        const path = join(this.logDir as string, name);
        const stat = statSync(path);
        return {
          name,
          path,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  flush(): void {
    if (!this.logDir || this.pending.length === 0) return;
    const chunk = `${this.pending.join('\n')}\n`;
    this.pending = [];
    const file = join(this.logDir, LOG_FILE);
    try {
      if (
        existsSync(file) &&
        statSync(file).size + chunk.length > this.maxFileBytes
      )
        this.rotate();
      appendFileSync(file, chunk);
    } catch (error) {
      if (this.toConsole) console.error('log file write failed', error);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  private rotate(): void {
    const dir = this.logDir as string;
    const rotated = (n: number) => join(dir, `wololo.${n}.txt`);
    rmSync(rotated(this.maxFiles - 1), { force: true });
    for (let n = this.maxFiles - 2; n >= 0; n--) {
      if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1));
    }
    renameSync(join(dir, LOG_FILE), rotated(0));
  }

  private write(
    level: LogLevel,
    module: string,
    message: string,
    data?: LogData,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const entry: LogEntry = {
      id: this.nextId++,
      time: new Date().toISOString(),
      level,
      module,
      message,
    };
    const normalized = normalizeData(data);
    if (normalized) entry.data = normalized;

    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();

    const line = formatLogLine(entry);
    if (this.logDir) this.pending.push(line);
    if (this.toConsole)
      (LEVEL_RANK[level] >= LEVEL_RANK.warn ? console.error : console.log)(
        line,
      );
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // a broken listener must never break logging
      }
    }
  }
}
