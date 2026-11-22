import { expect, test } from 'bun:test';
import { runResult } from '../../../test/helpers/runResult.ts';
import type { Logger } from '../../core/logger.ts';
import type { RunOptions, RunResult } from '../../core/process.ts';
import { probeTools } from './tools.ts';

const PATHS = { ffmpeg: 'ffmpeg', ffprobe: '/opt/ffprobe', mkvmerge: 'mkvmerge', sevenZip: '7z' };

function result(stdout: string, exitCode: number | null = 0): RunResult {
  return runResult({ stdout, exitCode });
}

const OUTPUTS: Record<string, string> = {
  '/bin/ffmpeg -version': 'ffmpeg version 7.1 Copyright',
  '/bin/ffmpeg -hide_banner -protocols': 'Input:\n  bluray\n  file\n',
  '/opt/ffprobe -version': 'ffprobe version 7.1 Copyright',
  '/bin/7z i': '7-Zip (a) 24.09 (x64) : Copyright',
  '/bin/nice --version': 'nice (GNU coreutils) 9.7',
};

test('probeTools - resolves paths, reads versions and flags missing tools', async () => {
  const calls: RunOptions[] = [];
  const report = await probeTools(PATHS, {
    which: (command) =>
      ({ ffmpeg: '/bin/ffmpeg', '/opt/ffprobe': '/opt/ffprobe', '7z': '/bin/7z', nice: '/bin/nice' })[command] ?? null,
    run: async (options) => {
      calls.push(options);
      const output = OUTPUTS[[options.command, ...options.args].join(' ')];
      if (output === undefined) throw new Error('unexpected command');
      return result(output);
    },
  });
  expect(report.ffmpegBluray).toBe(true);
  expect(report.tools).toEqual([
    { name: 'ffmpeg', path: '/bin/ffmpeg', version: '7.1', available: true },
    { name: 'ffprobe', path: '/opt/ffprobe', version: '7.1', available: true },
    { name: 'mkvmerge', path: null, version: null, available: false },
    { name: '7z', path: '/bin/7z', version: '24.09', available: true },
    { name: 'nice', path: '/bin/nice', version: '9.7', available: true },
    { name: 'ionice', path: null, version: null, available: false },
  ]);
  expect(calls.every((call) => call.lowPriority === false && call.timeoutMs !== undefined)).toBe(true);
});

test('probeTools - a tool that cannot be spawned is unavailable and the failure is logged', async () => {
  const debug: string[] = [];
  const ignore = () => undefined;
  const log: Logger = {
    trace: ignore,
    debug: (message) => debug.push(message),
    info: ignore,
    warn: ignore,
    error: ignore,
    child: () => log,
  };
  const report = await probeTools(PATHS, {
    which: (command) => (command === 'ffmpeg' ? '/bin/ffmpeg' : null),
    run: async () => {
      throw new Error('spawn failed');
    },
    log,
  });
  expect(report.tools[0]).toEqual({ name: 'ffmpeg', path: '/bin/ffmpeg', version: null, available: false });
  expect(report.ffmpegBluray).toBeNull();
  expect(debug).toContain('tool probe failed');
});

test('probeTools - a tool that exits 127 or times out is unavailable', async () => {
  const report = await probeTools(PATHS, {
    which: (command) => ({ mkvmerge: '/bin/mkvmerge', '7z': '/bin/7z' })[command] ?? null,
    run: async (options) =>
      options.command === '/bin/mkvmerge'
        ? { ...result('', 127), stderr: 'error while loading shared libraries: libQt6Core.so.6' }
        : { ...result('', null), timedOut: true, signalCode: 'SIGKILL' },
  });
  expect(report.tools.find((tool) => tool.name === 'mkvmerge')?.available).toBe(false);
  expect(report.tools.find((tool) => tool.name === '7z')?.available).toBe(false);
});

test('probeTools - a tool that runs but rejects the version flag stays available', async () => {
  const report = await probeTools(PATHS, {
    which: (command) => (command === 'nice' ? '/usr/bin/nice' : null),
    run: async () => ({ ...result('', 1), stderr: 'nice: -version: invalid nice value' }),
  });
  expect(report.tools.find((tool) => tool.name === 'nice')).toEqual({
    name: 'nice',
    path: '/usr/bin/nice',
    version: null,
    available: true,
  });
});

test('probeTools - without ffmpeg the Blu-ray support is unknown', async () => {
  const report = await probeTools(PATHS, { which: () => null, run: async () => result('') });
  expect(report.ffmpegBluray).toBeNull();
  expect(report.tools.every((tool) => !tool.available)).toBe(true);
});

test('probeTools - a failing -protocols call leaves Blu-ray support unknown', async () => {
  const report = await probeTools(PATHS, {
    which: (command) => (command === 'ffmpeg' ? '/bin/ffmpeg' : null),
    run: async (options) => (options.args.includes('-protocols') ? result('', 1) : result('ffmpeg version 7 x')),
  });
  expect(report.ffmpegBluray).toBeNull();
});
