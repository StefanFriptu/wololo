import type { JobSummary } from '#lib/shared.ts';

/** Test builder for JobSummary rows. */
export function jobFixture(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 1,
    type: 'audio',
    state: 'queued',
    step: 'waiting',
    priority: 0,
    trigger: 'scan',
    mediaFileId: 10,
    libraryId: 1,
    sourcePath: '/data/media/movies/Movie (2020)/Movie (2020).mkv',
    outputPath: null,
    title: 'Movie (2020)',
    progress: 0,
    speed: null,
    etaSec: null,
    error: null,
    attempts: 0,
    createdAt: '2026-11-15T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
