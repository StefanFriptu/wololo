import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { ProbeService } from '../../contracts/probe-scan.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import { AppError } from '../../core/errors.ts';
import { jobs as jobsTable, mediaFiles } from '../../db/schema.ts';
import type { Library } from '../../shared/domain.ts';
import type { EventMap, ScanStats } from '../../shared/events.ts';
import { fakeJobs, fakeRules } from './test-fakes.ts';

let t: TestContext;
let rulesState: { versionKey: string };
let jobs: ReturnType<typeof fakeJobs>;
let root: string;
let library: Library;
let probeCalls: number;
let events: { name: string; payload: unknown }[];

beforeEach(async () => {
  rulesState = { versionKey: '1@1' };
  probeCalls = 0;
  events = [];
  jobs = fakeJobs(() => t.ctx.db);
  t = createTestContext({ overrides: { rules: fakeRules(rulesState), jobs: jobs.service } });
  const real = t.ctx.services.probe;
  t.ctx.services.probe = {
    probe: (path, options) => {
      probeCalls += 1;
      return real.probe(path, options);
    },
  } satisfies ProbeService;
  t.ctx.events.onAny((event) => {
    if (event.name.startsWith('scan.') || event.name === 'media.removed') events.push(event);
  });
  root = join(t.dir, 'movies');
  mkdirSync(root, { recursive: true });
  library = await t.ctx.services.libraries.create({ name: 'Movies', kind: 'movies', roots: [root], profileIds: [] });
});

afterEach(() => t.cleanup());

async function runScan(request: { libraryId?: number; force?: boolean } = {}): Promise<EventMap['scan.finished']> {
  const done = new Promise<EventMap['scan.finished']>((resolve) => {
    const off = t.ctx.events.on('scan.finished', (payload) => {
      off();
      resolve(payload);
    });
  });
  await t.ctx.services.scan.start(request);
  return done;
}

const stats = (overrides: Partial<ScanStats>): ScanStats => ({
  filesSeen: 0,
  filesNew: 0,
  filesChanged: 0,
  filesRemoved: 0,
  filesProbed: 0,
  probeErrors: 0,
  jobsQueued: 0,
  ...overrides,
});

const statusOf = (path: string) =>
  t.ctx.db.select({ status: mediaFiles.status }).from(mediaFiles).where(eq(mediaFiles.path, path)).get()?.status;

test('scan.start - no libraries finishes with empty stats', async () => {
  await t.ctx.services.libraries.remove(library.id);
  const finished = await runScan();
  expect(finished.stats).toEqual(stats({}));
  expect(finished.error).toBeNull();
  expect(t.ctx.services.scan.current()).toMatchObject({ running: false, error: null });
});

test('scan.start - unknown library is not_found', async () => {
  const error = await t.ctx.services.scan.start({ libraryId: 999 }).catch((caught: unknown) => caught);
  expect((error as AppError).code).toBe('not_found');
});

test('scan.start - an inaccessible root keeps its rows and reports the problem', async () => {
  const seeded = { libraryId: library.id, rootIds: [library.roots[0]?.id as number] };
  const row = insertMediaFile(t.ctx.db, seeded, { path: join(root, 'kept.mkv'), status: 'compatible' });
  rmSync(root, { recursive: true });
  const finished = await runScan();
  expect(finished.error).toContain('is not accessible');
  expect(statusOf(row.path)).toBe('compatible');
});

test('scan.start - libraries without an effective profile are skipped with an error', async () => {
  t.ctx.services.rules = stubService<RulesService>('rules', {
    effectiveProfileForLibrary: async () => {
      throw new AppError('upstream', 'no profile available');
    },
  });
  const finished = await runScan();
  expect(finished.error).toContain('Movies: no profile available');
});

describe.skipIf(!ffmpegAvailable())('scans over fixture files', () => {
  let dts: string;
  let ac3: string;

  beforeEach(async () => {
    dts = await ensureFixtureCopy(FIXTURES.dts51, join(root, 'Movie A (2020)'), 'Movie A (2020).mkv');
    ac3 = await ensureFixtureCopy(FIXTURES.ac3Compatible, join(root, 'Movie B (2021)'), 'Movie B (2021).mkv');
    await ensureFixtureCopy(FIXTURES.dts51, join(root, 'Movie A (2020)', 'Sample'), 'sample.mkv');
  });

  test('scan - first scan probes new files, second scan probes nothing', async () => {
    const first = await runScan();
    expect(first.stats).toEqual(stats({ filesSeen: 2, filesNew: 2, filesProbed: 2 }));
    expect(first.error).toBeNull();
    expect(statusOf(dts)).toBe('needs_work');
    expect(statusOf(ac3)).toBe('compatible');
    const names = events.map((event) => event.name);
    expect([names[0], names.at(-1)]).toEqual(['scan.started', 'scan.finished']);
    expect(names).toContain('scan.progress');

    const second = await runScan();
    expect(second.stats).toEqual(stats({ filesSeen: 2 }));
    expect(probeCalls).toBe(2);
  });

  test('scan - a changed file is probed again, a profile edit re-checks without ffprobe', async () => {
    await runScan();
    utimesSync(ac3, new Date(), new Date(Date.now() + 60_000));
    const changed = await runScan();
    expect(changed.stats).toEqual(stats({ filesSeen: 2, filesChanged: 1, filesProbed: 1 }));

    rulesState.versionKey = '1@2';
    const rechecked = await runScan();
    expect(rechecked.stats).toEqual(stats({ filesSeen: 2 }));
    expect(probeCalls).toBe(3);
    const keys = t.ctx.db.select({ rulesKey: mediaFiles.rulesKey }).from(mediaFiles).all();
    expect(keys.every((row) => row.rulesKey === '1@2|replace|')).toBe(true);
  });

  test('scan - deleted files lose their row and emit media.removed', async () => {
    await runScan();
    rmSync(dts);
    const finished = await runScan();
    expect(finished.stats.filesRemoved).toBe(1);
    expect(statusOf(dts)).toBeUndefined();
    expect(events.some((event) => event.name === 'media.removed')).toBe(true);
  });

  test('scan - with processing enabled, the dry-run backlog is queued once', async () => {
    await runScan();
    expect(jobs.calls).toEqual([]);
    t.ctx.settings.update({ processing: { enabled: true } });
    const backlog = await runScan();
    expect(backlog.stats.jobsQueued).toBe(1);
    expect(jobs.calls).toMatchObject([{ type: 'audio', trigger: 'scan', title: 'Movie A (2020)' }]);
    const again = await runScan();
    expect(again.stats.jobsQueued).toBe(0);
    expect(t.ctx.db.select().from(jobsTable).all()).toHaveLength(1);
  });

  test('scan - new needs-work files are queued directly when processing is enabled', async () => {
    t.ctx.settings.update({ processing: { enabled: true } });
    const finished = await runScan();
    expect(finished.stats.jobsQueued).toBe(1);
  });

  test('scan - force re-probes everything, ignored rows included, and keeps them ignored', async () => {
    await runScan();
    const id = t.ctx.db.select().from(mediaFiles).where(eq(mediaFiles.path, dts)).get()?.id as number;
    await t.ctx.services.media.setIgnored(id, true);
    const forced = await runScan({ force: true });
    expect(forced.stats).toEqual(stats({ filesSeen: 2, filesProbed: 2 }));
    expect(statusOf(dts)).toBe('ignored');
  });

  test('scan - a scan of one library, start while running returns it, cancel stops it', async () => {
    const started = await t.ctx.services.scan.start({ libraryId: library.id });
    const again = await t.ctx.services.scan.start({});
    expect(again.scanId).toBe(started.scanId);
    expect(again.libraryId).toBe(library.id);
    await t.ctx.services.scan.cancel();
    const current = t.ctx.services.scan.current();
    expect(current).toMatchObject({ scanId: started.scanId, running: false, error: 'cancelled' });
    await t.ctx.services.scan.cancel();
  });
});
