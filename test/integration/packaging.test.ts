import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const VERSION_ARG = /^VERSION=\$\{\{ steps\.version\.outputs\.version \}\}$/;
const VERSION_LABEL = /^org\.opencontainers\.image\.version=\$\{\{ steps\.version\.outputs\.version \}\}$/;

interface Job {
  'timeout-minutes'?: number;
  steps?: { uses?: string; with?: Record<string, unknown> }[];
}

interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: { 'cancel-in-progress'?: unknown };
  jobs: Record<string, Job>;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(read(`.github/workflows/${name}`)) as Workflow;
}

test.each(['ci.yml', 'supply-chain.yml'])('%s - parses, is read-only by default and bounds every job', (name) => {
  const parsed = workflow(name);
  expect(parsed.permissions).toEqual({ contents: 'read' });
  expect(parsed.concurrency?.['cancel-in-progress']).toBeDefined();
  for (const job of Object.values(parsed.jobs)) expect(job['timeout-minutes']).toBeGreaterThan(0);
});

test('Dockerfile - the per-ref version comes after every RUN, so the apt and tool layers stay cached', () => {
  const runtimeStage =
    read('Dockerfile')
      .split(/^FROM /m)
      .at(-1) ?? '';
  const lines = runtimeStage.split('\n');
  const versionArg = lines.findIndex((line) => line.startsWith('ARG VERSION'));
  const lastRun = lines.findLastIndex((line) => line.startsWith('RUN '));
  expect(versionArg).toBeGreaterThan(lastRun);
  expect(runtimeStage).toMatch(/^ENV WOLOLO_VERSION=\$\{VERSION\}$/m);
});

test('Dockerfile - the runtime image ships the license text and .dockerignore keeps it in the context', () => {
  const runtimeStage =
    read('Dockerfile')
      .split(/^FROM /m)
      .at(-1) ?? '';
  expect(runtimeStage).toMatch(/^COPY (?:\S+ )*LICENSE (?:\S+ )*\.\/$/m);
  expect(read('.dockerignore').split('\n')).not.toContain('LICENSE');
  expect(read('LICENSE')).toContain('GNU GENERAL PUBLIC LICENSE');
});

test('ci.yml - image labels and build arg share one version', () => {
  const steps = workflow('ci.yml').jobs.image?.steps ?? [];
  const builds = steps.filter((step) => step.uses?.startsWith('docker/build-push-action'));
  expect(builds).toHaveLength(2);
  for (const build of builds) expect(build.with?.['build-args']).toMatch(VERSION_ARG);
  const meta = steps.find((step) => step.uses?.startsWith('docker/metadata-action'));
  expect(meta?.with?.labels).toMatch(VERSION_LABEL);
});

test('smoke-test.sh - a low-space config warning does not fail the image', () => {
  expect(read('docker/smoke-test.sh')).toContain('(.source == "config" and .level == "error")');
});
