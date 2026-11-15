import { expect, test } from 'bun:test';
import type { HealthCheck, ToolInfo } from '../../shared/api-types.ts';
import { buildHealthChecks, type HealthFacts, LOW_CONFIG_SPACE_BYTES } from './healthChecks.ts';

const TOOL_NAMES: ToolInfo['name'][] = ['ffmpeg', 'ffprobe', 'mkvmerge', '7z', 'nice', 'ionice'];

function facts(overrides: Partial<HealthFacts> = {}, missing: ToolInfo['name'][] = []): HealthFacts {
  return {
    platform: 'linux',
    isDocker: true,
    uid: 1000,
    tools: {
      tools: TOOL_NAMES.map((name) => {
        const available = !missing.includes(name);
        return { name, available, path: available ? `/usr/bin/${name}` : null, version: available ? '1.0' : null };
      }),
      ffmpegBluray: true,
    },
    libraryCount: 1,
    roots: [{ library: 'Movies', path: '/data/media/movies', problem: null }],
    configDir: '/config',
    configWritable: true,
    configFreeBytes: 50 * 1024 ** 3,
    processingEnabled: true,
    restorePending: false,
    ...overrides,
  };
}

function expectCheck(checks: HealthCheck[], level: HealthCheck['level'], fragment: string): void {
  const match = checks.find((check) => check.level === level && check.message.includes(fragment));
  if (!match) throw new Error(`no ${level} containing "${fragment}" in ${JSON.stringify(checks)}`);
}

test('buildHealthChecks - a healthy setup has no checks', () => {
  expect(buildHealthChecks(facts())).toEqual([]);
});

test.each<[ToolInfo['name'], HealthCheck['level']]>([
  ['ffmpeg', 'error'],
  ['ffprobe', 'error'],
  ['mkvmerge', 'warning'],
  ['7z', 'warning'],
  ['nice', 'notice'],
  ['ionice', 'notice'],
])('buildHealthChecks - missing %s is a %s', (name, level) => {
  const checks = buildHealthChecks(facts({}, [name]));
  expect(checks).toHaveLength(1);
  expectCheck(checks, level, `${name} not found`);
});

test('buildHealthChecks - missing ionice is expected outside Linux', () => {
  expect(buildHealthChecks(facts({ platform: 'darwin' }, ['ionice']))).toEqual([]);
});

test('buildHealthChecks - ffmpeg without libbluray warns, unknown support does not', () => {
  const base = facts();
  expectCheck(buildHealthChecks({ ...base, tools: { ...base.tools, ffmpegBluray: false } }), 'warning', 'libbluray');
  expect(buildHealthChecks({ ...base, tools: { ...base.tools, ffmpegBluray: null } })).toEqual([]);
});

test('buildHealthChecks - unreachable roots are errors naming library and path', () => {
  const checks = buildHealthChecks(
    facts({
      roots: [
        { library: 'Movies', path: '/data/media/movies', problem: 'ENOENT' },
        { library: 'TV', path: '/data/media/tv', problem: null },
      ],
    }),
  );
  expect(checks).toHaveLength(1);
  expectCheck(checks, 'error', 'Library "Movies": root folder /data/media/movies is not reachable (ENOENT)');
});

test('buildHealthChecks - no library yet is a notice', () => {
  expectCheck(buildHealthChecks(facts({ libraryCount: 0, roots: [] })), 'notice', 'No library yet');
});

test('buildHealthChecks - config problems', () => {
  expectCheck(buildHealthChecks(facts({ configWritable: false })), 'error', 'not writable');
  expectCheck(buildHealthChecks(facts({ configFreeBytes: LOW_CONFIG_SPACE_BYTES - 1 })), 'warning', '1.0 GiB free');
  expect(buildHealthChecks(facts({ configFreeBytes: LOW_CONFIG_SPACE_BYTES }))).toEqual([]);
  expect(buildHealthChecks(facts({ configFreeBytes: null }))).toEqual([]);
});

test('buildHealthChecks - root in Docker, dry run and staged restore', () => {
  expectCheck(buildHealthChecks(facts({ uid: 0 })), 'warning', 'runs as root');
  expect(buildHealthChecks(facts({ uid: 0, isDocker: false }))).toEqual([]);
  expectCheck(buildHealthChecks(facts({ processingEnabled: false })), 'notice', 'dry run');
  expectCheck(buildHealthChecks(facts({ restorePending: true })), 'notice', 'restart Wololo');
});

test('buildHealthChecks - most severe first', () => {
  const checks = buildHealthChecks(facts({ processingEnabled: false, configWritable: false }, ['mkvmerge']));
  expect(checks.map((check) => check.level)).toEqual(['error', 'warning', 'notice']);
});
