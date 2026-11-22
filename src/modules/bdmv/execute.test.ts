import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { writeDiscFolder } from '../../../test/fixtures/bdmv/disc.ts';
import { writeFake7z, writeFakeIso } from '../../../test/fixtures/bdmv/fake7z.ts';
import { cleanupSetup, conversionPlan, feature, PROBE, STN, setup, T } from '../../../test/fixtures/bdmv/service.ts';
import { writeSup } from '../../../test/fixtures/bdmv/writers.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import { createFakeRunContext, type FakeRunContext } from '../../../test/helpers/run-context.ts';
import type { MplsPlaylist } from '../../contracts/bdmv.ts';
import type { RulesInput } from '../../contracts/rules-ffmpeg.ts';
import type { RunOptions, RunResult } from '../../core/process.ts';
import type { ConversionPlan, PlannedStream } from '../../shared/domain.ts';
import {
  buildPacketCountArgs,
  buildSupExtractArgs,
  forcedScanTargets,
  outputTracks,
  parsePacketCount,
  placeFile,
  secondaryVideoNotes,
  sideFilePlan,
} from './execute.ts';

afterEach(cleanupSetup);

const planned = (sourceIndex: number, overrides: Partial<PlannedStream> = {}): PlannedStream => ({
  sourceIndex,
  kind: 'audio',
  op: 'copy',
  codec: 'ac3',
  encode: null,
  language: null,
  retagged: false,
  title: null,
  default: false,
  forced: false,
  ...overrides,
});

const plan = (streams: PlannedStream[]): ConversionPlan => ({
  action: 'convert',
  reasons: [],
  failingCodecs: ['dts'],
  streams,
  dropped: [],
  lostFeatures: ['7.1 downmixed to 5.1'],
  videoNotes: [],
  estimatedOutputBytes: null,
  rulesKey: 'k',
});

const ENCODE = { codec: 'ac3' as const, bitrateKbps: 640, channels: 6, channelLayout: '5.1', downmixed: false };

const FEATURE_PLAN = plan([
  planned(0, { kind: 'video', codec: 'h264', default: true }),
  planned(1, { op: 'encode', codec: 'ac3', encode: ENCODE, language: 'spa', default: true }),
  planned(2, { kind: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' }),
]);

test('forcedScanTargets - only PGS tracks of languages with several planned subtitles', () => {
  const probe = probeResult([
    videoStream(),
    subtitleStream({ codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    subtitleStream({ codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    subtitleStream({ codec: 'hdmv_pgs_subtitle', language: 'spa' }),
    subtitleStream({ codec: 'subrip', language: 'fre' }),
    subtitleStream({ codec: 'subrip', language: 'fre' }),
  ]);
  const subtitles = [1, 2, 3, 4, 5].map((i) =>
    planned(i, { kind: 'subtitle', language: probe.streams[i]?.language ?? null }),
  );
  expect(forcedScanTargets(plan(subtitles), probe)).toEqual([1, 2]);
  expect(forcedScanTargets(plan([subtitles[0] as PlannedStream]), probe)).toEqual([]);
});

test('buildSupExtractArgs - one pass, one sup output per track', () => {
  expect(
    buildSupExtractArgs('/d', '00800.mpls', [
      { sourceIndex: 3, path: '/t/a.sup' },
      { sourceIndex: 4, path: '/t/b.sup' },
    ]),
  ).toEqual([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-playlist',
    '800',
    '-i',
    'bluray:/d',
    '-map',
    '0:3',
    '-c',
    'copy',
    '-f',
    'sup',
    '/t/a.sup',
    '-map',
    '0:4',
    '-c',
    'copy',
    '-f',
    'sup',
    '/t/b.sup',
  ]);
});

test('buildPacketCountArgs - counts packets of the first video stream of the playlist', () => {
  expect(buildPacketCountArgs('/d', '00001.mpls')).toEqual([
    '-v',
    'error',
    '-playlist',
    '1',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    'bluray:/d',
  ]);
});

test.each([
  ['1234\n', 1234],
  ['  77  ', 77],
  ['N/A', null],
  ['', null],
  ['0', null],
])('parsePacketCount - %j', (stdout, count) => {
  expect(parsePacketCount(stdout)).toBe(count);
});

test('sideFilePlan - keeps one stream, not default, nothing dropped', () => {
  const reduced = sideFilePlan(FEATURE_PLAN, FEATURE_PLAN.streams[1] as PlannedStream);
  expect(reduced.streams).toEqual([{ ...(FEATURE_PLAN.streams[1] as PlannedStream), default: false }]);
  expect(reduced.dropped).toEqual([]);
  expect(reduced.lostFeatures).toEqual(FEATURE_PLAN.lostFeatures);
});

const DISC_PROBE = probeResult([
  videoStream({ streamId: 0x1011, startTimeSec: 600 }),
  audioStream({ streamId: 0x1100, codec: 'dts', language: 'spa', startTimeSec: 599.976 }),
  subtitleStream({ streamId: 0x1200, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
  audioStream({ streamId: null, codec: 'ac3' }),
  videoStream({ streamId: 0x1015, codec: 'hevc' }),
]);

test('outputTracks - PIDs, side files with sync delay, forced flags, video first', () => {
  const tracks = outputTracks({
    plan: plan([
      planned(1, { op: 'encode', encode: ENCODE, language: 'spa', default: true, title: 'Castellano' }),
      planned(0, { kind: 'video', codec: 'h264', default: true }),
      planned(2, { kind: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      planned(4, { kind: 'video', codec: 'hevc' }),
    ]),
    probe: DISC_PROBE,
    sideFiles: new Map([[1, '/t/a1.mka']]),
    forced: new Set([2]),
    dropPids: new Set([0x1015]),
  });
  expect(tracks).toEqual([
    {
      kind: 'video',
      pid: 0x1011,
      codec: 'h264',
      replacementPath: null,
      delayMs: 0,
      language: null,
      title: null,
      default: true,
      forced: false,
    },
    {
      kind: 'audio',
      pid: 0x1100,
      codec: null,
      replacementPath: '/t/a1.mka',
      delayMs: -24,
      language: 'spa',
      title: 'Castellano',
      default: true,
      forced: false,
    },
    {
      kind: 'subtitle',
      pid: 0x1200,
      codec: 'hdmv_pgs_subtitle',
      replacementPath: null,
      delayMs: 0,
      language: 'eng',
      title: null,
      default: false,
      forced: true,
    },
  ]);
});

test('outputTracks - a planned stream without a PID fails instead of vanishing from the output', () => {
  const input = { probe: DISC_PROBE, sideFiles: new Map<number, string>(), forced: new Set<number>() };
  expect(() => outputTracks({ ...input, plan: plan([planned(0, { kind: 'video' }), planned(3)]) })).toThrow(
    'planned audio stream 3 has no PID in the playlist',
  );
  expect(() => outputTracks({ ...input, plan: plan([planned(9)]) })).toThrow('planned audio stream 9 has no PID');
});

test('placeFile - moves the file and never overwrites an existing target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-place-'));
  try {
    touch(join(dir, 'a.mkv'), 'new');
    await placeFile(join(dir, 'a.mkv'), join(dir, 'out.mkv'));
    expect(readFileSync(join(dir, 'out.mkv'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'a.mkv'))).toBe(false);
    touch(join(dir, 'b.mkv'), 'other');
    await expect(placeFile(join(dir, 'b.mkv'), join(dir, 'out.mkv'))).rejects.toThrow('output already exists');
    expect(readFileSync(join(dir, 'out.mkv'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'b.mkv'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secondaryVideoNotes - MVC and Dolby Vision', () => {
  const stream = (codingType: number, codec: string, secondaryVideo: boolean) => ({
    kind: 'video' as const,
    pid: 0x1012,
    codingType,
    codec,
    language: null,
    secondaryVideo,
  });
  const playlist: MplsPlaylist = {
    name: '00800.mpls',
    durationSec: 1,
    playItems: [],
    streams: [
      stream(0x1b, 'h264', false),
      stream(0x20, 'h264', true),
      stream(0x24, 'hevc', true),
      stream(0x1b, 'h264', true),
    ],
    marks: [],
    chapterTimesSec: [],
  };
  expect(secondaryVideoNotes(playlist)).toEqual([
    '3D (MVC) dependent view dropped, 2D base view kept',
    'Dolby Vision enhancement layer dropped, HDR10 base layer kept',
    'secondary video (PID 0x1012) dropped',
  ]);
});

const IDENTIFY = JSON.stringify({
  tracks: [
    { id: 0, type: 'video', codec: 'AVC/H.264/MPEG-4p10', properties: { number: 0x1011 } },
    { id: 1, type: 'audio', codec: 'DTS-HD Master Audio', properties: { number: 0x1100, language: 'spa' } },
    { id: 2, type: 'subtitles', codec: 'HDMV PGS', properties: { number: 0x1200, language: 'eng' } },
    { id: 3, type: 'subtitles', codec: 'HDMV PGS', properties: { number: 0x1201, language: 'eng' } },
  ],
});

function ran(options: RunOptions, stdout = '', exitCode = 0): RunResult {
  return {
    argv: [options.command, ...options.args],
    exitCode,
    signalCode: null,
    stdout,
    stderr: exitCode === 0 ? '' : 'boom',
    durationMs: 1,
    aborted: false,
    timedOut: false,
  };
}

function touch(path: string, content: string | Uint8Array = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Plays ffmpeg, ffprobe and mkvmerge: writes their outputs so the executor can rename and stat them. */
function fakeTools(
  fake: FakeRunContext,
  commands: RunOptions[],
  options: { forcedSup?: string; mkvmergeExit?: number; packets?: string } = {},
) {
  fake.run = async (run) => {
    commands.push(run);
    const tool = basename(run.command);
    if (tool === 'fake7z') {
      const result = Bun.spawnSync([run.command, ...run.args], { stdout: 'pipe', stderr: 'pipe' });
      return { ...ran(run, result.stdout.toString(), result.exitCode ?? 1), stderr: result.stderr.toString() };
    }
    if (tool === 'ffprobe') return ran(run, options.packets ?? '1234\n');
    if (tool === 'mkvmerge' && run.args[0] === '-J') return ran(run, IDENTIFY);
    if (tool === 'mkvmerge') {
      run.onStdoutLine?.('Progress: 50%');
      touch(run.args[run.args.indexOf('--output') + 1] as string, 'matroska');
      return ran(run, '', options.mkvmergeExit ?? 0);
    }
    if (tool === 'ffmpeg') {
      run.args.forEach((arg, i) => {
        if (arg === 'sup') {
          const path = run.args[i + 1] as string;
          touch(path, writeSup([{ objects: [{ forced: path === options.forcedSup }] }]));
        }
      });
      if (!run.args.includes('sup')) {
        run.onStdoutLine?.('progress=end');
        touch(run.args.at(-1) as string, 'mka');
      }
      return ran(run);
    }
    return ran(run, '', 127);
  };
}

function job(s: ReturnType<typeof setup>, overrides: Parameters<typeof createFakeRunContext>[0] = {}) {
  return createFakeRunContext({
    ...overrides,
    job: { id: 31, type: 'bdmv', mediaFileId: s.mediaFileId, sourcePath: s.disc, ...overrides.job },
  });
}

test('bdmv.execute - encodes, muxes, verifies, renames, imports and records the result', async () => {
  const s = setup({ plan: FEATURE_PLAN, probe: (path) => (path.endsWith('.mkv') ? { ...PROBE, path } : PROBE) });
  const fake = job(s);
  const commands: RunOptions[] = [];
  fakeTools(fake, commands);
  const tempDir = join(s.root, '.wololo-tmp-31');
  const output = join(s.root, 'Jamón Jamón (1992)', 'Jamón Jamón (1992).mkv');

  const outcome = await s.t.ctx.services.bdmv.execute(fake);

  expect(fake.steps.map((step) => step.step)).toEqual([
    'preparing',
    'encoding',
    'muxing',
    'verifying',
    'importing',
    'done',
  ]);
  expect(fake.tempPaths).toEqual([tempDir, null]);
  expect(fake.freeSpaceChecks).toEqual([{ dir: s.root, bytes: 5000 }]);
  expect(existsSync(output)).toBe(true);
  expect(existsSync(tempDir)).toBe(false);
  expect(fake.progress.at(-1)).toBe(1);

  const tools = commands.map((c) => [basename(c.command), c.args[0]]);
  expect(tools).toEqual([
    ['ffmpeg', '-playlist'],
    ['mkvmerge', '-J'],
    ['mkvmerge', '--output'],
    ['ffprobe', '-v'],
  ]);
  expect(commands[0]?.args).toEqual([
    '-playlist',
    '800',
    '-i',
    `bluray:${s.disc}`,
    '-c:a',
    'ac3',
    `${tempDir}/0-a1.mka`,
  ]);
  const mux = commands[2]?.args ?? [];
  expect(mux).toContain(`${tempDir}/0-a1.mka`);
  expect(mux).toContain('--no-audio');
  expect(mux[mux.indexOf('--title') + 1]).toBe('Jamón Jamón (1992)');
  expect(mux.at(-1)).toBe('0:0,1:0,0:2');

  expect(fake.verifyRequests).toEqual([
    {
      sourcePath: s.disc,
      outputPath: `${tempDir}/0-00800.mkv`,
      expectedDurationSec: 5706,
      durationToleranceSec: 0.5,
      expectedStreamCount: 3,
      compareVideoHash: false,
      expectedVideoPackets: 1234,
      decodeAudioStreams: [1],
      expectedChapterCount: 2,
      expectedLanguages: [
        { kind: 'video', language: null },
        { kind: 'audio', language: 'spa' },
        { kind: 'subtitle', language: 'eng' },
      ],
    },
  ]);

  expect(s.calls.addMovie?.[0]?.[0]).toBe(7);
  expect(s.calls.addMovie?.[0]?.[1]).toMatchObject({ tmdbId: 4517, rootFolderPath: s.root, qualityProfileId: null });
  expect(s.calls.importMovieFolder).toEqual([[7, dirname(output), 99]]);
  expect(s.calls.recordJobResult).toEqual([
    [s.mediaFileId, { status: 'compatible', reason: `converted to ${output}`, lastJobId: 31 }],
  ]);
  expect(s.calls.fileChanged).toEqual([
    [
      {
        kind: 'created',
        localPath: output,
        mediaFileId: s.mediaFileId,
        arr: { instanceId: 7, kind: 'radarr', itemId: 99, fileId: null },
        jobId: 31,
      },
    ],
  ]);
  expect(s.calls.addHistory?.[0]?.[0]).toMatchObject({ event: 'imported', path: output, jobId: 31 });
  expect(outcome).toMatchObject({
    outputPath: output,
    lostFeatures: ['7.1 downmixed to 5.1'],
    verification: { passed: true },
    bytesAfter: 8,
    recycleBinEntryId: null,
    message: `converted to ${output}`,
  });
  expect(outcome.after).toEqual(PROBE.streams);
});

test('bdmv.execute - failed verification deletes the temp dir and writes nothing', async () => {
  const s = setup({ plan: FEATURE_PLAN });
  const fake = job(s, {
    verify: async () => ({ passed: false, checks: [{ name: 'chapters', passed: false, detail: 'expected 2, got 0' }] }),
  });
  fakeTools(fake, []);
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow(
    'verification failed for 00800.mpls: chapters: expected 2, got 0',
  );
  expect(fake.tempPaths).toEqual([join(s.root, '.wololo-tmp-31'), null]);
  expect(readdirSync(s.root)).toEqual(['Jamon.Jamon.1992.1080p.BluRay.x264-GRP']);
  expect(s.calls.recordJobResult).toBeUndefined();
});

test('bdmv.execute - mkvmerge errors fail the job, warnings (exit 1) do not', async () => {
  const failing = setup({ plan: FEATURE_PLAN });
  const fake = job(failing);
  fakeTools(fake, [], { mkvmergeExit: 2 });
  await expect(failing.t.ctx.services.bdmv.execute(fake)).rejects.toThrow('mkvmerge failed (exit 2): boom');
  cleanupSetup();

  const warning = setup({ plan: FEATURE_PLAN });
  const ok = job(warning);
  fakeTools(ok, [], { mkvmergeExit: 1 });
  expect((await warning.t.ctx.services.bdmv.execute(ok)).outputPath).toEndWith('Jamón Jamón (1992).mkv');
});

test('bdmv.execute - an existing output is a conflict before anything is written', async () => {
  const s = setup({ plan: FEATURE_PLAN });
  touch(join(s.root, 'Jamón Jamón (1992)', 'Jamón Jamón (1992).mkv'));
  const fake = job(s);
  fakeTools(fake, []);
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow('output already exists');
  expect(fake.tempPaths).toEqual([]);
});

test('bdmv.execute - a disc that now needs a decision is refused', async () => {
  const s = setup({
    plan: FEATURE_PLAN,
    playlists: {
      '00800.mpls': { playItems: [{ clipId: '00001', inTime: 0, outTime: 6000 * T, stn: STN }] },
      '00801.mpls': { playItems: [{ clipId: '00002', inTime: 0, outTime: 5900 * T, stn: STN }] },
    },
  });
  const fake = job(s);
  fakeTools(fake, []);
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow('a main_title decision is required');
});

test('bdmv.execute - Radarr import failures are reported but keep the written file', async () => {
  const s = setup({
    plan: FEATURE_PLAN,
    arr: {
      importMovieFolder: async () => {
        throw new Error('Radarr down');
      },
    },
  });
  const fake = job(s);
  fakeTools(fake, []);
  const outcome = await s.t.ctx.services.bdmv.execute(fake);
  expect(outcome.message).toEndWith('Radarr import failed: Radarr down; asked Radarr to rescan the movie instead');
  expect(existsSync(outcome.outputPath as string)).toBe(true);
  expect(s.calls.recordJobResult).toHaveLength(1);
  expect(s.calls.addHistory?.[0]?.[0]).toMatchObject({
    event: 'failed',
    path: outcome.outputPath,
    message: `Radarr import failed: Radarr down; the converted file stays in ${dirname(outcome.outputPath as string)}`,
    jobId: 31,
    data: { error: 'Radarr down', arrInstanceId: 7 },
  });
  expect(s.calls.rescan).toEqual([[{ instanceId: 7, kind: 'radarr', itemId: 99, fileId: null }]]);
});

test('bdmv.execute - forced PGS track detected when a language has two subtitle tracks', async () => {
  const twoSubs = probeResult(
    [
      videoStream({ streamId: 0x1011 }),
      audioStream({ streamId: 0x1100, codec: 'ac3', language: 'spa' }),
      subtitleStream({ streamId: 0x1200, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
      subtitleStream({ streamId: 0x1201, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
    ],
    { durationSec: 5706 },
  );
  const remux = plan([
    planned(0, { kind: 'video', codec: 'h264', default: true }),
    planned(1, { language: 'spa', default: true }),
    planned(2, { kind: 'subtitle', language: 'eng' }),
    planned(3, { kind: 'subtitle', language: 'eng' }),
  ]);
  const s = setup({ plan: remux, probe: () => twoSubs });
  const fake = job(s);
  const commands: RunOptions[] = [];
  const tempDir = join(s.root, '.wololo-tmp-31');
  fakeTools(fake, commands, { forcedSup: `${tempDir}/0-s3.sup` });
  await s.t.ctx.services.bdmv.execute(fake);
  expect(commands.map((c) => basename(c.command))).toEqual(['ffmpeg', 'mkvmerge', 'mkvmerge', 'ffprobe']);
  const mux = commands[2]?.args ?? [];
  const forcedFlags = mux.flatMap((arg, i) => (mux[i - 1] === '--forced-display-flag' ? [arg] : []));
  expect(forcedFlags).toEqual(['0:0', '1:0', '2:0', '3:1']);
  expect(mux).toContain('--audio-tracks');
  expect(fake.steps.map((step) => step.step)).not.toContain('encoding');
});

test('bdmv.execute - languages come from the MPLS stream table when the probe has none', async () => {
  const untagged = probeResult(
    [
      videoStream({ streamId: 0x1011 }),
      audioStream({ streamId: 0x1100, codec: 'dts', language: null }),
      subtitleStream({ streamId: 0x1200, codec: 'hdmv_pgs_subtitle', language: null, bitmap: true }),
    ],
    { durationSec: 5706 },
  );
  const s = setup({ probe: () => untagged });
  const fake = job(s);
  const commands: RunOptions[] = [];
  fakeTools(fake, commands);
  await s.t.ctx.services.bdmv.execute(fake);

  const input = s.calls.rulesPlan?.[0]?.[0] as RulesInput;
  expect(input.probe.streams.map((stream) => stream.language)).toEqual([null, 'spa', 'eng']);
  const mux = commands.find((c) => c.args[0] === '--output')?.args ?? [];
  const languages = mux.flatMap((arg, i) => (mux[i - 1] === '--language' ? [arg] : []));
  expect(languages).toEqual(['0:und', '1:spa', '2:eng']);
  expect(fake.verifyRequests[0]?.expectedLanguages).toEqual([
    { kind: 'video', language: null },
    { kind: 'audio', language: 'spa' },
    { kind: 'subtitle', language: 'eng' },
  ]);
});

const EDITIONS = { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 5800) };

test('bdmv.execute - two editions: one probe, plan, mux and verification per title, both written', async () => {
  const s = setup({ settings: { bdmv: { onAmbiguous: 'editions' } }, playlists: EDITIONS, plan: FEATURE_PLAN });
  const fake = job(s);
  const commands: RunOptions[] = [];
  fakeTools(fake, commands);
  const folder = join(s.root, 'Jamón Jamón (1992)');
  const extended = join(folder, 'Jamón Jamón (1992) {edition-Extended}.mkv');
  const theatrical = join(folder, 'Jamón Jamón (1992) {edition-Theatrical}.mkv');

  const outcome = await s.t.ctx.services.bdmv.execute(fake);

  expect(fake.freeSpaceChecks).toEqual([{ dir: s.root, bytes: 8000 }]);
  expect(s.calls.probe?.map((call) => (call[1] as { playlist?: string } | undefined)?.playlist)).toEqual([
    '00800.mpls',
    '00801.mpls',
    undefined,
  ]);
  expect(s.calls.rulesPlan).toHaveLength(2);
  const muxes = commands.filter((c) => c.args[0] === '--output');
  expect(muxes.map((c) => c.args[1])).toEqual([
    join(s.root, '.wololo-tmp-31', '0-00800.mkv'),
    join(s.root, '.wololo-tmp-31', '1-00801.mkv'),
  ]);
  expect(muxes[0]?.args).toContain(join(s.disc, 'BDMV', 'PLAYLIST', '00800.mpls'));
  expect(muxes[1]?.args).toContain(join(s.disc, 'BDMV', 'PLAYLIST', '00801.mpls'));
  expect(fake.verifyRequests.map((request) => request.expectedDurationSec)).toEqual([6000, 5800]);
  expect(existsSync(extended)).toBe(true);
  expect(existsSync(theatrical)).toBe(true);
  expect(s.calls.importMovieFolder).toEqual([[7, folder, 99]]);
  expect(s.calls.addHistory?.[0]?.[0]).toMatchObject({ event: 'imported', path: extended });
  expect(outcome).toMatchObject({
    outputPath: extended,
    bytesAfter: 16,
    message: `converted to ${extended}; 1 more title(s) written`,
  });
  expect(fake.progress.at(-1)).toBe(1);
});

test('bdmv.execute - a blocked extra is skipped with a note, a blocked edition fails the job', async () => {
  const extraPlan = conversionPlan('blocked');
  const withExtra = setup({
    settings: { bdmv: { extras: { enabled: true, minMinutes: 10 } } },
    playlists: { '00800.mpls': feature('00001', 6000), '00801.mpls': feature('00002', 1200) },
    plan: (input) => (input.probe.path === 'extra' ? extraPlan : FEATURE_PLAN),
    probe: (path, options) => ({ ...PROBE, path: options?.playlist === '00801.mpls' ? 'extra' : path }),
  });
  const fake = job(withExtra);
  const commands: RunOptions[] = [];
  fakeTools(fake, commands);
  const outcome = await withExtra.t.ctx.services.bdmv.execute(fake);
  expect(commands.filter((c) => c.args[0] === '--output')).toHaveLength(1);
  expect(outcome.message).toBe(
    `converted to ${outcome.outputPath}; extra 00801.mpls skipped (blocked: video codec vc1 not decoded by profile)`,
  );
  expect(existsSync(join(withExtra.root, 'Jamón Jamón (1992)', 'Featurettes'))).toBe(false);
  cleanupSetup();

  const editions = setup({
    settings: { bdmv: { onAmbiguous: 'editions' } },
    playlists: EDITIONS,
    plan: (input) => (input.probe.path === 'second' ? extraPlan : FEATURE_PLAN),
    probe: (path, options) => ({ ...PROBE, path: options?.playlist === '00801.mpls' ? 'second' : path }),
  });
  const failing = job(editions);
  fakeTools(failing, []);
  await expect(editions.t.ctx.services.bdmv.execute(failing)).rejects.toThrow(
    'edition 00801.mpls is blocked: video codec vc1 not decoded by profile',
  );
  expect(readdirSync(editions.root)).toEqual(['Jamon.Jamon.1992.1080p.BluRay.x264-GRP']);
});

test('bdmv.execute - a failed placement of the second title removes the first again', async () => {
  const s = setup({ settings: { bdmv: { onAmbiguous: 'editions' } }, playlists: EDITIONS, plan: FEATURE_PLAN });
  const fake = job(s);
  const theatrical = join(s.root, 'Jamón Jamón (1992)', 'Jamón Jamón (1992) {edition-Theatrical}.mkv');
  const commands: RunOptions[] = [];
  fakeTools(fake, commands);
  const mkvmerge = fake.run;
  fake.run = async (run) => {
    const result = await mkvmerge(run);
    if (run.args[0] === '--output' && run.args[1]?.endsWith('1-00801.mkv')) touch(theatrical, 'radarr got here first');
    return result;
  };
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow(`output already exists: ${theatrical}`);
  expect(readdirSync(join(s.root, 'Jamón Jamón (1992)'))).toEqual(['Jamón Jamón (1992) {edition-Theatrical}.mkv']);
  expect(readFileSync(theatrical, 'utf8')).toBe('radarr got here first');
  expect(existsSync(join(s.root, '.wololo-tmp-31'))).toBe(false);
});

test('bdmv.execute - an .iso is extracted per title into the temp dir and muxed from there', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'wololo-iso-exec-'));
  try {
    const folder = writeDiscFolder(join(scratch, 'folder'), {
      playlists: { '00800.mpls': feature('00001', 5706) },
      clips: { '00001': { streamBytes: 5000 } },
    });
    const iso = writeFakeIso(join(scratch, 'Jamon.Jamon.1992.iso'), folder);
    const s = setup({
      plan: FEATURE_PLAN,
      existingDisc: { path: iso, kind: 'iso' },
      env: { WOLOLO__7Z: writeFake7z(scratch) },
    });
    const fake = job(s);
    const commands: RunOptions[] = [];
    fakeTools(fake, commands);
    const tempDir = join(s.root, '.wololo-tmp-31');
    const output = (await s.t.ctx.services.bdmv.execute(fake)).outputPath as string;

    expect(fake.freeSpaceChecks).toEqual([{ dir: s.root, bytes: 10_000 }]);
    const extracts = commands.filter((c) => basename(c.command) === 'fake7z' && c.args[0] === 'x');
    expect(extracts.filter((c) => c.args.includes(`-o${join(tempDir, 'disc-0')}`))).toHaveLength(1);
    const playlistPath = join(tempDir, 'disc-0', 'BDMV', 'PLAYLIST', '00800.mpls');
    expect(commands.find((c) => c.args[0] === '-J')?.args).toEqual(['-J', playlistPath]);
    expect(commands.find((c) => c.args[0] === '--output')?.args).toContain(playlistPath);
    expect(commands.find((c) => c.args[0] === '-playlist')?.args).toContain(`bluray:${iso}`);
    expect(existsSync(output)).toBe(true);
    expect(existsSync(tempDir)).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('bdmv.execute - an unreadable video packet count fails verification instead of skipping it', async () => {
  const s = setup({ plan: FEATURE_PLAN });
  const fake = job(s);
  fakeTools(fake, [], { packets: 'N/A\n' });
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow(
    'could not count the video packets of 00800.mpls (ffprobe printed "N/A")',
  );
  expect(fake.verifyRequests).toEqual([]);
});

test('bdmv.execute - job without a media file is unprocessable', async () => {
  const s = setup();
  const fake = createFakeRunContext({ job: { type: 'bdmv', mediaFileId: null } });
  await expect(s.t.ctx.services.bdmv.execute(fake)).rejects.toThrow('has no media file');
});
