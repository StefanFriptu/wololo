import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { ensureFixtureCopy, FIXTURES, type FixtureSpec, ffmpegAvailable } from '../../../test/helpers/fixtures.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import { insertArrInstance, insertJob, insertMediaFile, insertProfile } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { BdmvEvaluation, BdmvService } from '../../contracts/bdmv.ts';
import type { ArrService } from '../../contracts/integrations.ts';
import type { ProbeService } from '../../contracts/probe-scan.ts';
import type { AppError } from '../../core/errors.ts';
import { mediaFiles } from '../../db/schema.ts';
import type { MediaQuery } from '../../shared/api-types.ts';
import type { ArrItemRef, BdmvJobPlan, ConversionPlan, Library } from '../../shared/domain.ts';
import type { EventMap } from '../../shared/events.ts';
import { summarizeProbe } from './evaluation.ts';
import { fakeJobs, fakeRules, TEST_DEFINITION } from './test-fakes.ts';

let t: TestContext;
let rulesState: { versionKey: string };
let jobs: ReturnType<typeof fakeJobs>;
let library: Library;
let root: string;
let probeCalls: string[];
let arrLookups: string[];
let arrResult: { ref: ArrItemRef; originalLanguage: string | null } | null | Error;
let discEvaluation: BdmvEvaluation;
let updates: EventMap['media.updated'][];

const MPEG4_VIDEO: FixtureSpec = {
  name: 'probe-scan-mpeg4',
  video: { codec: 'mpeg4' },
  audio: [{ codec: 'ac3', layout: 'stereo', language: 'eng' }],
};

beforeEach(async () => {
  rulesState = { versionKey: '1@1' };
  probeCalls = [];
  arrLookups = [];
  arrResult = null;
  updates = [];
  discEvaluation = { status: 'needs_work', reason: 'disc needs conversion', plan: null, decisionId: null };
  jobs = fakeJobs(() => t.ctx.db);
  t = createTestContext({
    overrides: {
      rules: fakeRules(rulesState),
      jobs: jobs.service,
      arr: stubService<ArrService>('arr', {
        findByPath: async (path) => {
          arrLookups.push(path);
          if (arrResult instanceof Error) throw arrResult;
          return arrResult;
        },
      }),
      bdmv: stubService<BdmvService>('bdmv', { evaluate: async () => discEvaluation }),
    },
  });
  const real = t.ctx.services.probe;
  t.ctx.services.probe = {
    probe: (path, options) => {
      probeCalls.push(path);
      return real.probe(path, options);
    },
  } satisfies ProbeService;
  t.ctx.events.on('media.updated', (payload) => updates.push(payload));
  root = join(t.dir, 'movies');
  mkdirSync(root, { recursive: true });
  library = await t.ctx.services.libraries.create({ name: 'Movies', kind: 'movies', roots: [root], profileIds: [] });
});

afterEach(() => t.cleanup());

const DISC_AUDIO_PLAN: ConversionPlan = {
  action: 'convert',
  reasons: ['truehd not decoded by profile'],
  failingCodecs: ['truehd'],
  streams: [],
  dropped: [],
  lostFeatures: [],
  videoNotes: [],
  estimatedOutputBytes: 1000,
  rulesKey: '1@1|replace',
};

function discPlan(sourcePath: string): BdmvJobPlan {
  return {
    sourcePath,
    sourceKind: 'bdmv',
    movie: { title: 'Disc', year: 2020, tmdbId: 1, imdbId: null, score: 1, radarrMovieId: null },
    radarrInstanceId: 1,
    rootFolderPath: '/movies',
    titles: [],
    audioPlan: DISC_AUDIO_PLAN,
    dolbyVision: 'drop_hdr10',
    estimatedOutputBytes: 25_000,
    extractBytes: 0,
  };
}

const media = () => t.ctx.services.media;
const rowOf = (path: string) => t.ctx.db.select().from(mediaFiles).where(eq(mediaFiles.path, path)).get();

test('media.checkPath - a path outside every library is unknown_path and writes nothing', async () => {
  const result = await media().checkPath('/elsewhere/a.mkv', { trigger: 'webhook' });
  expect(result).toEqual({
    action: 'unknown_path',
    mediaFile: null,
    jobId: null,
    message: '/elsewhere/a.mkv is not inside a library root',
  });
  expect(t.ctx.db.select().from(mediaFiles).all()).toEqual([]);
});

test('media.checkPath - a missing path inside a library fails without creating a row', async () => {
  const result = await media().checkPath(join(root, 'gone.mkv'), { trigger: 'webhook' });
  expect(result.action).toBe('failed');
  expect(result.mediaFile).toBeNull();
});

test('media.checkPath - disc folders go through bdmv.evaluate and queue a bdmv job', async () => {
  const disc = join(root, 'Disc');
  mkdirSync(join(disc, 'BDMV', 'STREAM'), { recursive: true });
  writeFileSync(join(disc, 'BDMV', 'index.bdmv'), 'x');
  writeFileSync(join(disc, 'BDMV', 'STREAM', '00001.m2ts'), Buffer.alloc(2048));
  const dryRun = await media().checkPath(disc, { trigger: 'scan' });
  expect(dryRun.action).toBe('dry_run');
  expect(dryRun.mediaFile).toMatchObject({
    kind: 'bdmv',
    sizeBytes: 2048,
    status: 'needs_work',
    failingCodecs: ['bdmv'],
  });
  expect(arrLookups).toEqual([]);

  t.ctx.settings.update({ processing: { enabled: true } });
  discEvaluation = { ...discEvaluation, plan: discPlan(disc) };
  const queued = await media().checkPath(disc, { trigger: 'scan' });
  expect(queued.action).toBe('queued');
  expect(jobs.calls).toMatchObject([{ type: 'bdmv', trigger: 'scan', title: 'Disc', plan: null }]);
  expect(jobs.calls[0]?.bdmvPlan).toEqual(discPlan(disc));
  expect(rowOf(disc)?.plan).toEqual({ ...DISC_AUDIO_PLAN, estimatedOutputBytes: 25_000 });

  discEvaluation = { status: 'pending', reason: 'pick the main title', plan: null, decisionId: 7 };
  const decision = await media().checkPath(disc, { trigger: 'scan' });
  expect(decision).toMatchObject({ action: 'decision_required', message: 'pick the main title' });
});

test('media.checkPath - discs are ignored when disc handling is disabled', async () => {
  const disc = join(root, 'Disc');
  mkdirSync(join(disc, 'BDMV'), { recursive: true });
  writeFileSync(join(disc, 'BDMV', 'index.bdmv'), 'x');
  t.ctx.settings.update({ bdmv: { enabled: false } });
  expect((await media().checkPath(disc, { trigger: 'scan' })).action).toBe('ignored');
  expect(rowOf(disc)).toBeUndefined();
});

test.each([
  ['.wololo-recycle/old.mkv', 'hidden or temporary path'],
  ['Recycle/old.mkv', 'inside the recycle bin'],
  ['Movie/Movie.wololo-tmp.mkv', 'hidden or temporary path'],
  ['Movie/notes.txt', 'not a media file extension'],
  ['Movie/Sample/sample.mkv', 'matches an ignore pattern'],
])('media.checkPath - %s is not checked (%s): no row, no probe, no job', async (relativePath, reason) => {
  t.ctx.settings.update({ processing: { enabled: true }, recycleBin: { path: `${root}/Recycle/` } });
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  const result = await media().checkPath(path, { trigger: 'webhook' });
  expect(result).toEqual({ action: 'ignored', mediaFile: null, jobId: null, message: `not checked: ${reason}` });
  expect(rowOf(path)).toBeUndefined();
  expect(probeCalls).toEqual([]);
  expect(jobs.calls).toEqual([]);
});

test('media.checkPath - files of a disabled library are not checked', async () => {
  const otherRoot = join(t.dir, 'disabled');
  mkdirSync(otherRoot, { recursive: true });
  await t.ctx.services.libraries.create({
    name: 'Off',
    kind: 'movies',
    roots: [otherRoot],
    profileIds: [],
    enabled: false,
  });
  const path = join(otherRoot, 'Movie.mkv');
  writeFileSync(path, 'x');
  t.ctx.settings.update({ processing: { enabled: true } });
  const result = await media().checkPath(path, { trigger: 'webhook' });
  expect(result).toMatchObject({ action: 'ignored', message: 'not checked: library is disabled' });
  expect(rowOf(path)).toBeUndefined();
  expect(jobs.calls).toEqual([]);
});

test('media.checkPath - an unexpected error is reported as failed instead of thrown', async () => {
  t.ctx.services.libraries = {
    ...t.ctx.services.libraries,
    findRootForPath: async () => Promise.reject(new Error('db gone')),
  };
  expect(await media().checkPath(join(root, 'A.mkv'), { trigger: 'webhook' })).toEqual({
    action: 'failed',
    mediaFile: null,
    jobId: null,
    message: 'check failed: db gone',
  });
});

describe.skipIf(!ffmpegAvailable())('with ffprobe fixtures', () => {
  test('media.checkPath - DTS file in dry-run mode: probed, planned, needs work, nothing queued', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const result = await media().checkPath(path, { trigger: 'webhook' });
    expect(result.action).toBe('dry_run');
    expect(result.jobId).toBeNull();
    expect(result.mediaFile).toMatchObject({
      libraryId: library.id,
      path,
      relativePath: 'Movie.mkv',
      kind: 'file',
      status: 'needs_work',
      statusReason: 'dts not decoded by profile',
      videoCodec: 'h264',
      audioCodecs: ['dts'],
      subtitleLanguages: ['eng'],
      failingCodecs: ['dts'],
      planAction: 'convert',
    });
    const row = rowOf(path);
    expect(row?.rulesKey).toBe('1@1|replace|');
    expect(row?.probe?.streams).toHaveLength(3);
    expect(row?.durationSec).toBeGreaterThan(2.5);
    expect(jobs.calls).toEqual([]);
    expect(updates.at(-1)).toEqual({ mediaFileId: row?.id as number, status: 'needs_work', path });
  });

  test('media.checkPath - compatible AC3 file', async () => {
    const path = await ensureFixtureCopy(FIXTURES.ac3Compatible, root, 'Ok.mkv');
    const result = await media().checkPath(path, { trigger: 'scan' });
    expect(result).toMatchObject({ action: 'compatible', mediaFile: { status: 'compatible', planAction: 'skip' } });
  });

  test('media.checkPath - processing enabled queues an audio job with the plan', async () => {
    t.ctx.settings.update({ processing: { enabled: true } });
    const path = await ensureFixtureCopy(FIXTURES.eac3Stereo, root, 'Show.mkv');
    const result = await media().checkPath(path, { trigger: 'webhook' });
    expect(result.action).toBe('queued');
    expect(result.jobId).toBeGreaterThan(0);
    expect(jobs.calls).toMatchObject([
      {
        type: 'audio',
        trigger: 'webhook',
        mediaFileId: result.mediaFile?.id,
        title: 'Show',
        plan: { action: 'convert' },
      },
    ]);
  });

  test('media.checkPath - a failing queue is reported, the row keeps needs_work', async () => {
    const failing = createTestContext({
      settings: { processing: { enabled: true } },
      overrides: { rules: fakeRules(), jobs: fakeJobs(() => failing.ctx.db, { fail: true }).service },
    });
    try {
      const dir = join(failing.dir, 'lib');
      await failing.ctx.services.libraries.create({ name: 'L', kind: 'movies', roots: [dir], profileIds: [] });
      const path = await ensureFixtureCopy(FIXTURES.eac3Stereo, dir, 'a.mkv');
      const result = await failing.ctx.services.media.checkPath(path, { trigger: 'webhook' });
      expect(result.action).toBe('failed');
      expect(result.message).toContain('queue unavailable');
      expect(result.mediaFile?.status).toBe('needs_work');
    } finally {
      failing.cleanup();
    }
  });

  test('media.checkPath - unsupported video is blocked (failed, plan action blocked)', async () => {
    const path = await ensureFixtureCopy(MPEG4_VIDEO, root, 'Old.mkv');
    t.ctx.settings.update({ processing: { enabled: true } });
    const result = await media().checkPath(path, { trigger: 'scan' });
    expect(result.action).toBe('blocked');
    expect(result.mediaFile).toMatchObject({ status: 'blocked', planAction: 'blocked', failingCodecs: ['mpeg4'] });
    expect(result.mediaFile?.statusReason).toContain('blocked: video mpeg4 not supported');
    expect(jobs.calls).toEqual([]);
  });

  test('media.checkPath - a probe failure is stored without a rules key, so the next check probes again', async () => {
    const path = join(root, 'broken.mkv');
    writeFileSync(path, 'not a video');
    const result = await media().checkPath(path, { trigger: 'scan' });
    expect(result.action).toBe('failed');
    expect(result.mediaFile?.statusReason).toStartWith('probe failed: ffprobe failed');
    expect(rowOf(path)?.rulesKey).toBeNull();
    await media().checkPath(path, { trigger: 'scan' });
    expect(probeCalls).toHaveLength(2);
  });

  test('media.checkPath - concurrent checks of one new file both succeed on a single row', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const results = await Promise.all([
      media().checkPath(path, { trigger: 'webhook' }),
      media().checkPath(path, { trigger: 'webhook' }),
    ]);
    expect(results.map((result) => result.action)).toEqual(['dry_run', 'dry_run']);
    expect(t.ctx.db.select().from(mediaFiles).where(eq(mediaFiles.path, path)).all()).toHaveLength(1);
  });

  test('media.checkPath - an unchanged file reuses the stored probe; a touched file is probed again', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    await media().checkPath(path, { trigger: 'scan' });
    await media().checkPath(path, { trigger: 'webhook' });
    expect(probeCalls).toHaveLength(1);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await media().checkPath(path, { trigger: 'webhook' });
    expect(probeCalls).toHaveLength(2);
  });

  test('media.checkPath - ignored rows stay ignored; processing rows are left alone', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const first = await media().checkPath(path, { trigger: 'scan' });
    const id = first.mediaFile?.id as number;
    await media().setIgnored(id, true);
    const ignored = await media().checkPath(path, { trigger: 'webhook' });
    expect(ignored).toMatchObject({
      action: 'ignored',
      mediaFile: { status: 'ignored', statusReason: 'ignored by user' },
    });

    await media().setIgnored(id, false);
    await media().setStatus(id, 'processing', 'job 5');
    const processing = await media().checkPath(path, { trigger: 'webhook' });
    expect(processing).toMatchObject({ action: 'queued', message: 'a job is processing this file' });
    expect(rowOf(path)?.statusReason).toBe('job 5');
  });

  test('media.checkPath - arr refs from the webhook are cached; otherwise arr.findByPath fills them', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const instanceId = insertArrInstance(t.ctx.db);
    const ref: ArrItemRef = { instanceId, kind: 'radarr', itemId: 12, fileId: 34 };
    await media().checkPath(path, { trigger: 'webhook', arr: ref, originalLanguage: 'spa' });
    expect(arrLookups).toEqual([]);
    const detail = await media().get(rowOf(path)?.id as number);
    expect(detail.arr).toEqual(ref);
    expect(detail.originalLanguage).toBe('spa');

    const other = await ensureFixtureCopy(FIXTURES.ac3Compatible, root, 'Other.mkv');
    arrResult = { ref: { ...ref, itemId: 99 }, originalLanguage: 'fre' };
    await media().checkPath(other, { trigger: 'scan' });
    expect(arrLookups).toEqual([other]);
    expect(rowOf(other)).toMatchObject({ arrItemId: 99, originalLanguage: 'fre' });
    await media().checkPath(other, { trigger: 'scan' });
    expect(arrLookups).toHaveLength(1);
  });

  test('media.checkPath - arr lookup failures are not fatal; no lookup without an enabled instance', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    await media().checkPath(path, { trigger: 'scan' });
    expect(arrLookups).toEqual([]);
    insertArrInstance(t.ctx.db);
    arrResult = new Error('radarr down');
    const result = await media().checkPath(path, { trigger: 'scan' });
    expect(arrLookups).toEqual([path]);
    expect(result.action).toBe('dry_run');
  });

  test('media.reprobe - runs ffprobe again and returns the detail', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const id = (await media().checkPath(path, { trigger: 'scan' })).mediaFile?.id as number;
    const detail = await media().reprobe(id);
    expect(probeCalls).toHaveLength(2);
    expect(detail.probe?.streams).toHaveLength(3);
    expect(detail.plan?.action).toBe('convert');
  });

  test('media.previewPlan - plans with the current profile without persisting', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const id = (await media().checkPath(path, { trigger: 'scan' })).mediaFile?.id as number;
    rulesState.versionKey = '1@2';
    const plan = await media().previewPlan(id);
    expect(plan.rulesKey).toBe('1@2|replace');
    expect(rowOf(path)?.rulesKey).toBe('1@1|replace|');
  });

  test('media.recordJobResult - stores the outcome with fresh size, mtime, probe and plan', async () => {
    const path = await ensureFixtureCopy(FIXTURES.dts51, root, 'Movie.mkv');
    const id = (await media().checkPath(path, { trigger: 'scan' })).mediaFile?.id as number;
    const converted = await ensureFixtureCopy(FIXTURES.ac3Compatible, root, 'Movie.mkv');
    const probe = await t.ctx.services.probe.probe(converted);
    await media().recordJobResult(id, { status: 'compatible', reason: null, lastJobId: 5, probe });
    const row = rowOf(path);
    expect(row).toMatchObject({
      status: 'compatible',
      lastJobId: 5,
      sizeBytes: Bun.file(path).size,
      audioCodecs: ['ac3'],
      failingCodecs: [],
      planAction: 'skip',
      rulesKey: '1@1|replace|',
    });
    probeCalls.length = 0;
    await media().checkPath(path, { trigger: 'scan' });
    expect(probeCalls).toEqual([]);
  });
});

describe('media rows without files', () => {
  const seeded = () => ({ libraryId: library.id, rootIds: [library.roots[0]?.id as number] });

  test('media.list - filters by status list, codec, failing codec, kind, search; sorts and pages', async () => {
    const dts = probeResult([
      videoStream(),
      audioStream({ codec: 'dts' }),
      subtitleStream({ codec: 'hdmv_pgs_subtitle' }),
    ]);
    insertMediaFile(t.ctx.db, seeded(), {
      path: join(root, 'A.mkv'),
      sizeBytes: 300,
      status: 'needs_work',
      probe: dts,
      ...summarizeProbe(dts),
      failingCodecs: ['dts'],
    });
    insertMediaFile(t.ctx.db, seeded(), {
      path: join(root, 'B.mkv'),
      sizeBytes: 100,
      status: 'compatible',
      videoCodec: 'hevc',
      audioCodecs: ['ac3'],
      streamCodecs: ['hevc', 'ac3'],
    });
    insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'Disc'), sizeBytes: 200, kind: 'bdmv', status: 'failed' });

    const list = async (query: MediaQuery) => (await media().list(query)).items.map((item) => item.relativePath);
    expect(await list({})).toEqual(['A.mkv', 'B.mkv', 'Disc']);
    expect(await list({ status: 'compatible,failed' })).toEqual(['B.mkv', 'Disc']);
    expect(await list({ codec: 'DTS' })).toEqual(['A.mkv']);
    expect(await list({ codec: 'hevc' })).toEqual(['B.mkv']);
    expect(await list({ codec: 'hdmv_pgs_subtitle' })).toEqual(['A.mkv']);
    expect(await list({ failingCodec: 'dts' })).toEqual(['A.mkv']);
    expect(await list({ kind: 'bdmv' })).toEqual(['Disc']);
    expect(await list({ search: 'b.MK' })).toEqual(['B.mkv']);
    expect(await list({ search: '%' })).toEqual([]);
    expect(await list({ sortKey: 'size', sortDir: 'desc' })).toEqual(['A.mkv', 'Disc', 'B.mkv']);
    const page = await media().list({ page: 2, pageSize: 2 });
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.items.map((item) => item.relativePath)).toEqual(['Disc']);
    expect(await list({ libraryId: library.id + 1 })).toEqual([]);
  });

  test('media.list - a trailing * in codec and failing codec matches as a prefix with _ taken literally', async () => {
    insertMediaFile(t.ctx.db, seeded(), {
      path: join(root, 'Pcm.mkv'),
      streamCodecs: ['h264', 'pcm_s24le'],
      failingCodecs: ['pcm_s24le'],
    });
    insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'Ac3.mkv'), streamCodecs: ['h264', 'ac3'] });
    insertMediaFile(t.ctx.db, seeded(), {
      path: join(root, 'Lookalike.mkv'),
      streamCodecs: ['pcmxs24le'],
      failingCodecs: ['pcmxs24le'],
    });

    const list = async (query: MediaQuery) => (await media().list(query)).items.map((item) => item.relativePath);
    expect(await list({ codec: 'pcmxs24le' })).toEqual(['Lookalike.mkv']);
    expect(await list({ codec: 'pcm_*' })).toEqual(['Pcm.mkv']);
    expect(await list({ codec: 'PCM_*' })).toEqual(['Pcm.mkv']);
    expect(await list({ failingCodec: 'pcm_*' })).toEqual(['Pcm.mkv']);
    expect(await list({ codec: 'pcm_s24le' })).toEqual(['Pcm.mkv']);
    expect(await list({ codec: 'pcm_s2' })).toEqual([]);
    expect(await list({ codec: '*' })).toEqual(['Ac3.mkv', 'Lookalike.mkv', 'Pcm.mkv']);
  });

  test('media.list - profile filter covers assigned libraries and, for the builtin default, unassigned ones', async () => {
    const builtin = insertProfile(t.ctx.db, TEST_DEFINITION, { builtin: true });
    const custom = insertProfile(t.ctx.db, TEST_DEFINITION);
    const other = await t.ctx.services.libraries.create({
      name: 'Kids',
      kind: 'movies',
      roots: [join(t.dir, 'kids')],
      profileIds: [custom],
    });
    insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv') });
    insertMediaFile(
      t.ctx.db,
      { libraryId: other.id, rootIds: [other.roots[0]?.id as number] },
      { path: join(t.dir, 'kids', 'K.mkv') },
    );
    const paths = async (profileId: number) =>
      (await media().list({ profileId })).items.map((item) => item.relativePath);
    expect(await paths(custom)).toEqual(['K.mkv']);
    expect(await paths(builtin)).toEqual(['A.mkv']);
  });

  test('media.stats - totals, every status present, failing codecs without ignored rows', async () => {
    insertMediaFile(t.ctx.db, seeded(), {
      path: '/x/1',
      sizeBytes: 10,
      status: 'needs_work',
      failingCodecs: ['dts', 'truehd'],
    });
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/2', sizeBytes: 20, status: 'needs_work', failingCodecs: ['dts'] });
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/3', sizeBytes: 30, status: 'ignored', failingCodecs: ['eac3'] });
    const stats = await media().stats();
    expect(stats).toEqual({
      total: 3,
      totalBytes: 60,
      byStatus: { pending: 0, compatible: 0, needs_work: 2, blocked: 0, processing: 0, failed: 0, ignored: 1 },
      byFailingCodec: [
        { codec: 'dts', count: 2 },
        { codec: 'truehd', count: 1 },
      ],
    });
    expect((await media().stats(library.id + 1)).total).toBe(0);
  });

  test('media.get - detail with jobs, newest first; unknown id is not_found', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv') });
    insertJob(t.ctx.db, { sourcePath: row.path, mediaFileId: row.id, state: 'failed' });
    const latest = insertJob(t.ctx.db, { sourcePath: row.path, mediaFileId: row.id });
    const detail = await media().get(row.id);
    expect(detail.jobs.map((job) => job.id)[0]).toBe(latest.id);
    expect(detail.jobs).toHaveLength(2);
    expect(detail.arr).toBeNull();
    const error = await media()
      .get(9999)
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('not_found');
  });

  test('media.findByPath - summary or null', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv') });
    expect((await media().findByPath(row.path))?.id).toBe(row.id);
    expect(await media().findByPath(join(root, 'nope.mkv'))).toBeNull();
  });

  test('media.setIgnored - refuses while processing; reason stored', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv'), status: 'processing' });
    const error = await media()
      .setIgnored(row.id, true)
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('conflict');
    await media().setStatus(row.id, 'compatible', null);
    const ignored = await media().setIgnored(row.id, true, 'restored from recycle bin');
    expect(ignored).toMatchObject({ status: 'ignored', statusReason: 'restored from recycle bin' });
  });

  test('media.setIgnored - cancels the queued jobs of the file and leaves other jobs alone', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv'), status: 'needs_work' });
    const other = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'B.mkv'), status: 'needs_work' });
    const queued = insertJob(t.ctx.db, { sourcePath: row.path, mediaFileId: row.id, state: 'queued' });
    insertJob(t.ctx.db, { sourcePath: row.path, mediaFileId: row.id, state: 'failed' });
    insertJob(t.ctx.db, { sourcePath: other.path, mediaFileId: other.id, state: 'queued' });

    const ignored = await media().setIgnored(row.id, true);

    expect(jobs.cancelled).toEqual([queued.id]);
    expect(ignored).toMatchObject({ status: 'ignored', statusReason: 'ignored by user' });
  });

  test('media.setStatus and recordJobResult - unknown ids are not_found', async () => {
    const codes = await Promise.all([
      media()
        .setStatus(404, 'failed', null)
        .catch((caught: AppError) => caught.code),
      media()
        .recordJobResult(404, { status: 'failed', reason: 'x', lastJobId: 1 })
        .catch((caught: AppError) => caught.code),
    ]);
    expect(codes).toEqual(['not_found', 'not_found']);
  });

  test('media.recordJobResult - a new path replaces a stale row at that path', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mp4') });
    const stale = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv') });
    const removed: number[] = [];
    t.ctx.events.on('media.removed', ({ mediaFileId }) => removed.push(mediaFileId));
    await media().recordJobResult(row.id, {
      status: 'compatible',
      reason: null,
      lastJobId: 3,
      path: join(root, 'A.mkv'),
    });
    expect(removed).toEqual([stale.id]);
    expect(rowOf(join(root, 'A.mkv'))?.id).toBe(row.id);
  });

  test('media.invalidateRules - rows with an outdated rules key become pending; ignored and processing stay', async () => {
    const current = '1@1|replace|';
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/old', rulesKey: current, status: 'compatible' });
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/ignored', rulesKey: current, status: 'ignored' });
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/processing', rulesKey: current, status: 'processing' });
    insertMediaFile(t.ctx.db, seeded(), { path: '/x/never', rulesKey: null, status: 'failed' });
    expect(await media().invalidateRules({ libraryId: library.id })).toBe(1);
    expect(rowOf('/x/never')?.status).toBe('pending');

    rulesState.versionKey = '1@2';
    expect(await media().invalidateRules({ profileId: 1 })).toBe(1);
    expect(rowOf('/x/old')).toMatchObject({ status: 'pending', statusReason: 'rules changed, waiting for re-check' });
    expect(rowOf('/x/ignored')?.status).toBe('ignored');
    expect(rowOf('/x/processing')?.status).toBe('processing');
    expect(await media().invalidateRules({})).toBe(0);
  });

  test('media.recordJobResult - a converted disc clears its plan and failing codecs', async () => {
    const disc = insertMediaFile(t.ctx.db, seeded(), {
      path: join(root, 'Disc'),
      kind: 'bdmv',
      status: 'needs_work',
      plan: DISC_AUDIO_PLAN,
      planAction: 'remux',
      failingCodecs: ['bdmv'],
    });
    await media().recordJobResult(disc.id, {
      status: 'compatible',
      reason: 'converted to /movies/Disc.mkv',
      lastJobId: 4,
    });
    expect(rowOf(disc.path)).toMatchObject({ status: 'compatible', plan: null, planAction: 'skip', failingCodecs: [] });
    expect((await media().stats()).byFailingCodec).toEqual([]);
    expect((await media().list({ failingCodec: 'bdmv' })).total).toBe(0);
  });

  test('media.previewPlan - disc rows return their stored plan or 422', async () => {
    const disc = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'Disc'), kind: 'bdmv' });
    const error = await media()
      .previewPlan(disc.id)
      .catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe('unprocessable');
  });

  test('media.checkPath - a missing file marks its existing row failed', async () => {
    const row = insertMediaFile(t.ctx.db, seeded(), { path: join(root, 'A.mkv'), status: 'compatible' });
    await media().checkPath(row.path, { trigger: 'webhook' });
    expect(rowOf(row.path)).toMatchObject({ status: 'failed', statusReason: 'file not found' });
  });
});
