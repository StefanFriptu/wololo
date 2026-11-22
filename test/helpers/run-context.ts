/** A recording JobRunContext for executor tests (jobs audio executor, bdmv.execute) without the worker. */
import type { JobRunContext, VerifyRequest } from '../../src/contracts/jobs.ts';
import { runProcess } from '../../src/core/process.ts';
import type { JobDetail, JobStep, VerificationResult } from '../../src/shared/domain.ts';

export interface FakeRunContext extends JobRunContext {
  steps: { step: JobStep; message?: string }[];
  progress: number[];
  lines: string[];
  tempPaths: (string | null)[];
  freeSpaceChecks: { dir: string; bytes: number }[];
  verifyRequests: VerifyRequest[];
  abort(): void;
}

export function fakeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 1,
    type: 'audio',
    state: 'running',
    step: 'preparing',
    priority: 0,
    trigger: 'manual',
    mediaFileId: 1,
    libraryId: 1,
    profileId: null,
    sourcePath: '/data/media/movies/Movie (2020)/Movie (2020).mkv',
    outputPath: null,
    title: 'Movie (2020)',
    progress: 0,
    speed: null,
    etaSec: null,
    error: null,
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    plan: null,
    bdmvPlan: null,
    before: null,
    after: null,
    lostFeatures: [],
    verification: null,
    bytesBefore: null,
    bytesAfter: null,
    hasLog: false,
    recycleBinEntryId: null,
    ...overrides,
  };
}

/**
 * run() really executes the command (no nice/ionice). ensureFreeSpace and verify only record their input unless
 * replaced: pass `verify` to return a specific result, `ensureFreeSpace` to simulate a full disk.
 */
export function createFakeRunContext(
  options: {
    job?: Partial<JobDetail>;
    verify?: (request: VerifyRequest) => Promise<VerificationResult>;
    ensureFreeSpace?: (dir: string, bytes: number) => Promise<void>;
  } = {},
): FakeRunContext {
  const controller = new AbortController();
  const fake: FakeRunContext = {
    job: fakeJob(options.job),
    signal: controller.signal,
    steps: [],
    progress: [],
    lines: [],
    tempPaths: [],
    freeSpaceChecks: [],
    verifyRequests: [],
    abort: () => controller.abort(),
    log: {
      line: (text) => fake.lines.push(text),
      section: (title) => fake.lines.push(`== ${title} ==`),
    },
    setStep: (step, message) => fake.steps.push({ step, message }),
    reportProgress: (update) => fake.progress.push(update.progress),
    setTempPath: async (path) => {
      fake.tempPaths.push(path);
    },
    run: (runOptions) =>
      runProcess({
        ...runOptions,
        signal: controller.signal,
        lowPriority: false,
        onStderrLine: (line) => {
          fake.lines.push(line);
          runOptions.onStderrLine?.(line);
        },
      }),
    ensureFreeSpace: async (dir, bytes) => {
      fake.freeSpaceChecks.push({ dir, bytes });
      await options.ensureFreeSpace?.(dir, bytes);
    },
    verify: async (request) => {
      fake.verifyRequests.push(request);
      return options.verify ? options.verify(request) : { passed: true, checks: [] };
    },
  };
  return fake;
}
