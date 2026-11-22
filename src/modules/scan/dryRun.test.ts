import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import { audioStream, probeResult, videoStream } from '../../../test/helpers/probe.ts';
import { insertLibrary, insertMediaFile, insertProfile, type SeededLibrary } from '../../../test/helpers/seed.ts';
import { stubService } from '../../../test/helpers/stubs.ts';
import type { ProfileService } from '../../contracts/rules-ffmpeg.ts';
import { AppError } from '../../core/errors.ts';
import { mediaFiles } from '../../db/schema.ts';
import type { ProfileWithUsage } from '../../shared/api-types.ts';
import type { ConversionPlan, DeviceProfileDefinition, PlanAction } from '../../shared/domain.ts';
import { fakeRules, TEST_DEFINITION } from './test-fakes.ts';

const MB = 1024 * 1024;
const GB = 1024 * MB;

let t: TestContext;
let libraryA: SeededLibrary;
let libraryB: SeededLibrary;
let tizenId: number;
let customId: number;
let profilesFail: boolean;

const CUSTOM_DEFINITION: DeviceProfileDefinition = {
  ...TEST_DEFINITION,
  audio: { ...TEST_DEFINITION.audio, allowedCodecs: ['ac3', 'aac', 'eac3'] },
};

function plan(action: PlanAction, failingCodecs: string[], estimatedOutputBytes: number | null): ConversionPlan {
  return {
    action,
    reasons: [],
    failingCodecs,
    streams: [],
    dropped: [],
    lostFeatures: [],
    videoNotes: [],
    estimatedOutputBytes,
    rulesKey: 'k',
  };
}

function profile(id: number, name: string, definition: DeviceProfileDefinition): ProfileWithUsage {
  return {
    id,
    name,
    description: '',
    version: 1,
    definition,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    libraryIds: [],
  };
}

const fileProbe = (audioCodec: string, sizeBytes: number, durationSec: number, videoCodec = 'h264') =>
  probeResult([videoStream({ codec: videoCodec }), audioStream({ codec: audioCodec })], { sizeBytes, durationSec });

beforeEach(() => {
  profilesFail = false;
  t = createTestContext({
    settings: { recycleBin: { enabled: true, retentionDays: 7 } },
    overrides: {
      rules: fakeRules(),
      profiles: stubService<ProfileService>('profiles', {
        get: async (id) => {
          if (profilesFail) throw new AppError('upstream', 'profiles unavailable');
          return id === customId
            ? profile(id, 'Bedroom TV', CUSTOM_DEFINITION)
            : profile(id, 'Samsung Tizen', TEST_DEFINITION);
        },
      }),
    },
  });
  tizenId = insertProfile(t.ctx.db, TEST_DEFINITION, { name: 'Samsung Tizen' });
  customId = insertProfile(t.ctx.db, CUSTOM_DEFINITION, { name: 'Bedroom TV' });
  libraryA = insertLibrary(t.ctx.db, { name: 'A', roots: ['/data/a'], profileIds: [tizenId] });
  libraryB = insertLibrary(t.ctx.db, { name: 'B', roots: ['/data/b', '/data/b2'], profileIds: [customId] });
  const db = t.ctx.db;
  insertMediaFile(db, libraryA, {
    path: '/data/a/1.mkv',
    sizeBytes: 4 * GB,
    durationSec: 7200,
    status: 'needs_work',
    planAction: 'convert',
    failingCodecs: ['dts'],
    plan: plan('convert', ['dts'], 3.5 * GB),
    probe: fileProbe('dts', 4 * GB, 7200),
  });
  insertMediaFile(db, libraryA, {
    path: '/data/a/2.mkv',
    sizeBytes: 2 * GB,
    durationSec: 3600,
    status: 'needs_work',
    planAction: 'convert',
    failingCodecs: ['dts', 'truehd'],
    plan: plan('convert', ['dts', 'truehd'], null),
    probe: fileProbe('dts', 2 * GB, 3600),
  });
  insertMediaFile(db, libraryA, {
    path: '/data/a/3.mkv',
    status: 'compatible',
    planAction: 'skip',
    probe: fileProbe('ac3', MB, 60),
  });
  insertMediaFile(db, libraryA, {
    path: '/data/a/4.mkv',
    sizeBytes: GB,
    durationSec: 100,
    status: 'blocked',
    planAction: 'blocked',
    failingCodecs: ['mpeg4'],
    videoCodec: 'mpeg4',
    probe: fileProbe('ac3', GB, 100, 'mpeg4'),
  });
  insertMediaFile(db, libraryA, {
    path: '/data/a/5.mkv',
    status: 'ignored',
    failingCodecs: ['eac3'],
    probe: fileProbe('eac3', MB, 60),
  });
  insertMediaFile(db, libraryA, { path: '/data/a/6.mkv', status: 'pending', probe: fileProbe('aac', MB, 60) });
  insertMediaFile(db, libraryA, { path: '/data/a/9.mkv', status: 'failed', statusReason: 'probe failed' });
  insertMediaFile(db, libraryB, {
    path: '/data/b/Disc',
    kind: 'bdmv',
    sizeBytes: 30 * GB,
    status: 'needs_work',
    planAction: 'remux',
    failingCodecs: ['bdmv'],
  });
  insertMediaFile(
    db,
    { ...libraryB, rootIds: [libraryB.rootIds[1] as number] },
    {
      path: '/data/b2/8.mkv',
      sizeBytes: GB,
      durationSec: 1800,
      status: 'needs_work',
      planAction: 'convert',
      failingCodecs: ['eac3'],
      probe: fileProbe('eac3', GB, 1800),
    },
  );
});

afterEach(() => t.cleanup());

test('dryRun.report - totals, groups per failing codec, time and space for the whole install', async () => {
  const report = await t.ctx.services.dryRun.report({});
  expect(report.libraryId).toBeNull();
  expect(report.processingEnabled).toBe(false);
  expect(report.totals).toEqual({
    files: 9,
    compatible: 1,
    needsWork: 4,
    blocked: 1,
    failed: 1,
    pending: 1,
    ignored: 1,
  });
  expect(report.groups).toEqual([
    {
      codec: 'dts',
      files: 2,
      durationSec: 10800,
      sizeBytes: 6 * GB,
      estimatedSeconds: 935 + 468,
      estimatedOutputBytes: 3.5 * GB + 2 * GB,
      samplePaths: ['/data/a/1.mkv', '/data/a/2.mkv'],
    },
    {
      codec: 'bdmv',
      files: 1,
      durationSec: 0,
      sizeBytes: 30 * GB,
      estimatedSeconds: 768,
      estimatedOutputBytes: 30 * GB,
      samplePaths: ['/data/b/Disc'],
    },
    {
      codec: 'eac3',
      files: 1,
      durationSec: 1800,
      sizeBytes: GB,
      estimatedSeconds: 234,
      estimatedOutputBytes: GB,
      samplePaths: ['/data/b2/8.mkv'],
    },
    {
      codec: 'truehd',
      files: 1,
      durationSec: 3600,
      sizeBytes: 2 * GB,
      estimatedSeconds: 468,
      estimatedOutputBytes: 2 * GB,
      samplePaths: ['/data/a/2.mkv'],
    },
    {
      codec: 'video:mpeg4',
      files: 1,
      durationSec: 100,
      sizeBytes: GB,
      estimatedSeconds: 0,
      estimatedOutputBytes: 0,
      samplePaths: ['/data/a/4.mkv'],
    },
  ]);
  expect(report.estimatedSeconds).toBe(Math.round((7200 + 3600 + 1800) / 7.7 + 768));
  expect(report.estimatedRecycleBytes).toBe(7 * GB);
  expect(report.estimatedExtraBytes).toBe(Math.round(3.5 * GB * 1.05) + Math.round(GB * 1.05) + 30 * GB + 7 * GB);
});

test('dryRun.report - byProfile re-plans stored probes per assigned profile', async () => {
  const report = await t.ctx.services.dryRun.report({});
  expect(report.byProfile).toEqual([
    {
      profileId: tizenId,
      name: 'Samsung Tizen',
      files: 5,
      failing: 3,
      durationSec: 7200 + 3600 + 100,
      estimatedSeconds: 935 + 468,
      estimatedOutputBytes: Math.round(4 * GB * 0.9) + Math.round(2 * GB * 0.9),
    },
    {
      profileId: customId,
      name: 'Bedroom TV',
      files: 1,
      failing: 0,
      durationSec: 0,
      estimatedSeconds: 0,
      estimatedOutputBytes: 0,
    },
  ]);
  const onlyCustom = await t.ctx.services.dryRun.report({ profileId: customId });
  expect(onlyCustom.byProfile.map((row) => row.profileId)).toEqual([customId]);
});

test('dryRun.report - library filter', async () => {
  const report = await t.ctx.services.dryRun.report({ libraryId: libraryB.libraryId });
  expect(report.libraryId).toBe(libraryB.libraryId);
  expect(report.totals.files).toBe(2);
  expect(report.groups.map((group) => group.codec)).toEqual(['bdmv', 'eac3']);
  expect(report.byProfile.map((row) => row.profileId)).toEqual([customId]);
  const missing = await t.ctx.services.dryRun.report({ libraryId: 999 }).catch((caught: unknown) => caught);
  expect((missing as AppError).code).toBe('not_found');
});

test('dryRun.report - recycle bin disabled needs no recycle space', async () => {
  t.ctx.settings.update({ recycleBin: { enabled: false } });
  const report = await t.ctx.services.dryRun.report({});
  expect(report.estimatedRecycleBytes).toBe(0);
  expect(report.estimatedExtraBytes).toBe(Math.round(3.5 * GB * 1.05) + Math.round(GB * 1.05) + 30 * GB);
});

test('dryRun.report - discs use their planned output; an .iso also needs room to extract its largest title', async () => {
  t.ctx.settings.update({ recycleBin: { enabled: false } });
  const before = await t.ctx.services.dryRun.report({ libraryId: libraryB.libraryId });
  const disc = { kind: 'bdmv' as const, status: 'needs_work' as const, planAction: 'remux' as const };
  insertMediaFile(t.ctx.db, libraryB, {
    ...disc,
    path: '/data/b/Folder Disc',
    sizeBytes: 40 * GB,
    failingCodecs: ['bdmv'],
    plan: plan('convert', ['truehd'], 25 * GB),
  });
  insertMediaFile(t.ctx.db, libraryB, {
    ...disc,
    kind: 'iso',
    path: '/data/b/Image.iso',
    sizeBytes: 45 * GB,
    failingCodecs: ['bdmv'],
    plan: plan('convert', ['truehd'], 20 * GB),
  });
  const report = await t.ctx.services.dryRun.report({ libraryId: libraryB.libraryId });
  expect(report.estimatedExtraBytes - before.estimatedExtraBytes).toBe(25 * GB + 20 * GB + 20 * GB);
  const group = report.groups.find((candidate) => candidate.codec === 'bdmv');
  expect(group?.estimatedOutputBytes).toBe(30 * GB + 25 * GB + 20 * GB);
});

test('dryRun.report - a failing profile service leaves byProfile empty, the rest of the report intact', async () => {
  profilesFail = true;
  const report = await t.ctx.services.dryRun.report({});
  expect(report.byProfile).toEqual([]);
  expect(report.totals.files).toBe(9);
});

test('dryRun.report - writes nothing', async () => {
  const before = JSON.stringify(t.ctx.db.select().from(mediaFiles).all());
  await t.ctx.services.dryRun.report({});
  expect(JSON.stringify(t.ctx.db.select().from(mediaFiles).all())).toBe(before);
});

test('dryRun.report - a large library lets the event loop run between pages', async () => {
  const probe = fileProbe('dts', MB, 60);
  for (let i = 0; i < 600; i++) {
    insertMediaFile(t.ctx.db, libraryA, {
      path: `/data/a/bulk/${i}.mkv`,
      status: 'needs_work',
      probe,
      planAction: 'convert',
      failingCodecs: ['dts'],
    });
  }
  let ranDuringReport = false;
  setImmediate(() => {
    ranDuringReport = true;
  });

  const report = await t.ctx.services.dryRun.report({});

  expect(ranDuringReport).toBe(true);
  expect(report.totals.needsWork).toBeGreaterThan(600);
});
