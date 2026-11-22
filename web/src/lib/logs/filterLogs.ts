import { LOG_LEVELS, type LogEntry, type LogLevel } from '#lib/shared.ts';

interface LogFilter {
  /** Minimum level shown. */
  level: LogLevel;
  module: string | null;
  search: string;
}

export function filterLogs(entries: readonly LogEntry[], { level, module, search }: LogFilter): LogEntry[] {
  const minimum = LOG_LEVELS.indexOf(level);
  const needle = search.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      LOG_LEVELS.indexOf(entry.level) >= minimum &&
      (module === null || entry.module === module) &&
      (needle === '' || entry.message.toLowerCase().includes(needle)),
  );
}
