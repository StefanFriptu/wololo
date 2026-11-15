import type { ToolPaths } from '../../core/config.ts';
import { errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { RunOptions, RunResult } from '../../core/process.ts';
import type { ToolInfo } from '../../shared/api-types.ts';
import { hasFfmpegProtocol, parseToolVersion } from './toolVersion.ts';

export interface ToolReport {
  tools: ToolInfo[];
  /** Whether ffmpeg can read Blu-ray structures (libbluray); null when ffmpeg is missing or could not be asked. */
  ffmpegBluray: boolean | null;
}

export interface ToolProbeDeps {
  which: (command: string) => string | null;
  run: (options: RunOptions) => Promise<RunResult>;
  signal?: AbortSignal;
  log?: Logger;
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Shell convention: 126 = found but not executable, 127 = could not be loaded (e.g. a missing shared library). */
const CANNOT_EXECUTE_EXIT_CODES = new Set([126, 127]);

function toolCommands(paths: ToolPaths): { name: ToolInfo['name']; command: string; args: string[] }[] {
  return [
    { name: 'ffmpeg', command: paths.ffmpeg, args: ['-version'] },
    { name: 'ffprobe', command: paths.ffprobe, args: ['-version'] },
    { name: 'mkvmerge', command: paths.mkvmerge, args: ['--version'] },
    { name: '7z', command: paths.sevenZip, args: ['i'] },
    { name: 'nice', command: 'nice', args: ['--version'] },
    { name: 'ionice', command: 'ionice', args: ['--version'] },
  ];
}

async function runQuietly(deps: ToolProbeDeps, command: string, args: string[]): Promise<RunResult | null> {
  try {
    return await deps.run({
      command,
      args,
      lowPriority: false,
      signal: deps.signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    deps.log?.debug('tool probe failed', { command, args, error: errorMessage(error) });
    return null;
  }
}

function couldExecute(result: RunResult): boolean {
  if (result.timedOut || result.signalCode !== null) return false;
  return result.exitCode === null || !CANNOT_EXECUTE_EXIT_CODES.has(result.exitCode);
}

/** Resolves each external tool on PATH (or its configured path) and reads its version; never throws for a missing tool. */
export async function probeTools(paths: ToolPaths, deps: ToolProbeDeps): Promise<ToolReport> {
  const tools = await Promise.all(
    toolCommands(paths).map(async ({ name, command, args }): Promise<ToolInfo> => {
      const path = deps.which(command);
      if (!path) return { name, path: null, version: null, available: false };
      const result = await runQuietly(deps, path, args);
      if (!result || !couldExecute(result)) {
        deps.log?.debug('tool found but cannot run', {
          name,
          path,
          exitCode: result?.exitCode,
          stderr: result?.stderr,
        });
        return { name, path, version: null, available: false };
      }
      return { name, path, version: parseToolVersion(name, `${result.stdout}\n${result.stderr}`), available: true };
    }),
  );
  const ffmpeg = tools.find((tool) => tool.name === 'ffmpeg');
  if (!ffmpeg?.path) return { tools, ffmpegBluray: null };
  const protocols = await runQuietly(deps, ffmpeg.path, ['-hide_banner', '-protocols']);
  const ffmpegBluray = protocols?.exitCode === 0 ? hasFfmpegProtocol(protocols.stdout, 'bluray') : null;
  return { tools, ffmpegBluray };
}
