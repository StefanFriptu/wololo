import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { audioStream, probeResult, videoStream } from '../../../test/helpers/probe.ts';
import { insertMediaFile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { JobsService } from '../../contracts/jobs.ts';
import type { ProbeService } from '../../contracts/probe-scan.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import { AppError } from '../../core/errors.ts';
import { jobs as jobsTable, mediaFiles } from '../../db/schema.ts';
import type { Library } from '../../shared/domain.ts';
import type { EventMap, ScanStats } from '../../shared/events.ts';
import { removable } from './scan.ts';
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
const rowOf = (path: string) => t.ctx.db.select().from(mediaFiles).where(eq(mediaFiles.path, path)).get();
const seeded = () => ({ libraryId: library.id, rootIds: [library.roots[0]?.id as number] });

function file(relativePath: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  return path;
}

/** Compatible probe for any path, or the given behaviour; counts calls in probeCalls. */
function fakeProbe(behaviour?: (path: string, signal: AbortSignal | undefined) => Promise<void>) {
  t.ctx.services.probe = {
    probe: async (path, options) => {
      probeCalls += 1;
      await behaviour?.(path, options?.signal);
      return probeResult([videoStream(), audioStream({ codec: 'ac3' })], { path, sizeBytes: statSync(path).size });
    },
  } satisfies ProbeService;
}

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

test('scan - an empty root keeps its rows and reports it; a force scan removes them', async () => {
  insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A/A.mkv'), status: 'compatible' });
  insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'B/B.mkv'), status: 'ignored' });
  const finished = await runScan();
  expect(finished.error).toContain('looks empty (not mounted?), kept 2 file(s)');
  expect(finished.stats.filesRemoved).toBe(0);
  expect(statusOf(join(root, 'B/B.mkv'))).toBe('ignored');

  const forced = await runScan({ force: true });
  expect(forced.stats.filesRemoved).toBe(2);
  expect(forced.error).toBeNull();
});

test('scan - files the settings now exclude: disc rows and ignored rows stay, other rows go', async () => {
  fakeProbe();
  const keep = file('Keep/Keep.mkv');
  const disc = file('Disc/BDMV/index.bdmv').replace('/BDMV/index.bdmv', '');
  const image = file('Image/Movie.iso');
  const ignored = file('Old/ignored.avi');
  const excluded = file('Old/other.avi');
  const gone = join(root, 'Gone/Gone.mkv');
  insertMediaFile(t.ctx.db, seeded(), {
    path: disc,
    kind: 'bdmv',
    status: 'compatible',
    statusReason: 'converted to x',
  });
  insertMediaFile(t.ctx.db, seeded(), { path: image, kind: 'iso', status: 'needs_work' });
  insertMediaFile(t.ctx.db, seeded(), { path: ignored, status: 'ignored' });
  insertMediaFile(t.ctx.db, seeded(), { path: excluded, status: 'needs_work' });
  insertMediaFile(t.ctx.db, seeded(), { path: gone, status: 'ignored' });
  t.ctx.settings.update({ bdmv: { enabled: false }, media: { extensions: ['.mkv', '.iso'] } });

  const finished = await runScan();
  expect(finished.error).toBeNull();
  expect(finished.stats).toMatchObject({ filesSeen: 1, filesRemoved: 2 });
  expect(statusOf(keep)).toBe('compatible');
  expect(rowOf(disc)).toMatchObject({ status: 'compatible', statusReason: 'converted to x' });
  expect(statusOf(image)).toBe('needs_work');
  expect(statusOf(ignored)).toBe('ignored');
  expect(rowOf(excluded)).toBeUndefined();
  expect(rowOf(gone)).toBeUndefined();
});

test.skipIf(process.getuid?.() === 0)(
  'scan - a file that cannot be stat-ed keeps its row; the scan reports it',
  async () => {
    fakeProbe();
    file('Keep/Keep.mkv');
    const locked = file('Locked/Locked.mkv');
    insertMediaFile(t.ctx.db, seeded(), { path: locked, status: 'ignored' });
    chmodSync(join(root, 'Locked'), 0o444);
    try {
      const finished = await runScan();
      expect(finished.error).toContain('1 file(s) under');
      expect(finished.stats.filesRemoved).toBe(0);
      expect(statusOf(locked)).toBe('ignored');
    } finally {
      chmodSync(join(root, 'Locked'), 0o755);
    }
  },
);

test('scan - keeps a row whose file still exists but could not be stat-ed during the walk', async () => {
  fakeProbe();
  file('Keep/Keep.mkv');
  const flaky = file('Flaky/Flaky.mkv');
  await runScan();
  const before = rowOf(flaky);
  expect(before).toBeDefined();
  const realStat = fsPromises.stat;
  let failed = 0;
  const spy = spyOn(fsPromises, 'stat').mockImplementation(((path: string, options?: never) => {
    if (path === flaky && failed === 0) {
      failed += 1;
      return Promise.reject(Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: 'EIO' }));
    }
    return realStat(path, options);
  }) as typeof fsPromises.stat);
  try {
    const finished = await runScan();

    expect(failed).toBe(1);
    expect(finished.stats).toMatchObject({ filesSeen: 1, filesRemoved: 0 });
    expect(finished.error).toContain('1 file(s) under');
    expect(rowOf(flaky)?.id).toBe(before?.id ?? -1);
  } finally {
    spy.mockRestore();
  }
});

test.each([
  ['missing', false, true],
  ['unknown', true, false],
  ['present', true, true],
  ['present', false, false],
] as const)(
  'removable - a needs-work file %s on disk, excluded %p, is removable %p',
  (presence, excluded, expected) => {
    expect(removable({ kind: 'file', status: 'needs_work' }, presence, excluded)).toBe(expected);
  },
);

test('removable - an excluded ignored file and an excluded disc stay', () => {
  expect(removable({ kind: 'file', status: 'ignored' }, 'present', true)).toBe(false);
  expect(removable({ kind: 'bdmv', status: 'compatible' }, 'present', true)).toBe(false);
});

test('scan - a discs-only library indexes disc folders and images, never the seeding files beside them', async () => {
  fakeProbe();
  const seeding = file('Movie.2020.1080p.DTS/Movie.2020.mkv');
  const disc = file('Disc/BDMV/index.bdmv').replace('/BDMV/index.bdmv', '');
  const image = file('Image/Movie.iso');
  insertMediaFile(t.ctx.db, seeded(), { path: seeding, status: 'needs_work' });
  await t.ctx.services.libraries.update(library.id, {
    ...library,
    roots: library.roots.map((r) => r.path),
    discsOnly: true,
  });

  const finished = await runScan();
  expect(finished.error).toBeNull();
  expect(rowOf(disc)?.kind).toBe('bdmv');
  expect(rowOf(image)?.kind).toBe('iso');
  expect(rowOf(seeding)).toBeUndefined();
  expect(jobs.calls.some((call) => JSON.stringify(call).includes(seeding))).toBe(false);
});

test('scan - a probe failure is retried by the next scan', async () => {
  let failures = 1;
  fakeProbe(async () => {
    if (failures-- > 0) throw new AppError('upstream', 'ffprobe timed out');
  });
  const path = file('Movie/Movie.mkv');
  const first = await runScan();
  expect(first.stats).toMatchObject({ filesProbed: 1, probeErrors: 1 });
  expect(rowOf(path)).toMatchObject({ status: 'failed', rulesKey: null });

  const second = await runScan();
  expect(second.stats).toMatchObject({ filesProbed: 1, probeErrors: 0 });
  expect(rowOf(path)).toMatchObject({ status: 'compatible', rulesKey: '1@1|replace|' });
});

test('scan - cancelling during a probe leaves the row for the next scan', async () => {
  const path = file('Movie/Movie.mkv');
  const before = insertMediaFile(t.ctx.db, seeded(), {
    path,
    sizeBytes: 999,
    status: 'compatible',
    statusReason: 'checked before',
    rulesKey: '1@1|replace|',
  });
  let probing: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    probing = resolve;
  });
  fakeProbe(
    (_path, signal) =>
      new Promise((_resolve, reject) => {
        probing();
        signal?.addEventListener('abort', () => reject(new AppError('upstream', 'ffprobe aborted')));
      }),
  );
  const done = runScan();
  await started;
  await t.ctx.services.scan.cancel();
  const cancelled = await done;
  expect(cancelled.error).toBe('cancelled');
  expect(cancelled.stats.probeErrors).toBe(0);
  expect(rowOf(path)).toMatchObject({
    status: 'compatible',
    statusReason: 'checked before',
    sizeBytes: before.sizeBytes,
    mtimeMs: before.mtimeMs,
  });

  fakeProbe();
  const next = await runScan();
  expect(next.stats).toMatchObject({ filesChanged: 1, filesProbed: 1, probeErrors: 0 });
  expect(rowOf(path)).toMatchObject({ status: 'compatible', sizeBytes: 1 });
});

test('scan - removes rows missing on disk across several pages and keeps the files still there', async () => {
  fakeProbe();
  const present = file('Here (2020).mkv');
  await runScan();
  for (let i = 0; i < 1200; i++) insertMediaFile(t.ctx.db, seeded(), { path: join(root, `Gone ${i}.mkv`) });

  const finished = await runScan();

  expect(finished.stats.filesRemoved).toBe(1200);
  expect(t.ctx.db.select({ path: mediaFiles.path }).from(mediaFiles).all()).toEqual([{ path: present }]);
});

test('scan - queueing a large backlog lets the event loop run between slices', async () => {
  const paths = Array.from({ length: 120 }, (_, i) => file(`Movie ${i} (2020).mkv`));
  t.ctx.services.probe = {
    probe: async (path) => probeResult([videoStream(), audioStream({ codec: 'dts' })], { path, sizeBytes: 1 }),
  } satisfies ProbeService;
  await runScan();
  expect(paths.map(statusOf).every((status) => status === 'needs_work')).toBe(true);
  t.ctx.settings.update({ processing: { enabled: true } });
  const queue = jobs.service.enqueue;
  let queuedBeforeYield: number | null = null;
  t.ctx.services.jobs = stubService<JobsService>('jobs', {
    enqueue: async (job) => {
      if (jobs.calls.length === 0) setImmediate(() => (queuedBeforeYield = jobs.calls.length));
      return queue(job);
    },
  });

  const finished = await runScan();

  expect(finished.stats.jobsQueued).toBe(120);
  expect(queuedBeforeYield).toBeLessThan(120);
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
