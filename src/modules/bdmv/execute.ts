import { link, mkdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AppContext } from '../../app/context.ts';
import type { MkvmergeOutputTrack, MplsPlaylist } from '../../contracts/bdmv.ts';
import type { JobExecutor, JobOutcome, JobRunContext } from '../../contracts/jobs.ts';
import { TEMP_FILE_MARKER } from '../../contracts/jobs.ts';
import { blurayInput, playlistArgs } from '../../core/bluray.ts';
import { AppError, errnoCode, errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { RunResult } from '../../core/process.ts';
import type {
  BdmvJobPlan,
  BdmvOutputTitle,
  ConversionPlan,
  JobStep,
  MediaStream,
  PlannedStream,
  ProbeResult,
  VerificationResult,
} from '../../shared/domain.ts';
import { createIsoReader } from './iso.ts';
import { buildMkvmergeArgs, mkvmergeSucceeded, parseMkvmergeIdentify, parseMkvmergeProgress } from './mkvmerge.ts';
import { type DiscPlanner, loadDiscRow, withPlaylistLanguages } from './planner.ts';
import { countForcedPgsCompositions } from './titles.ts';

const PGS_CODEC = 'hdmv_pgs_subtitle';
const DURATION_TOLERANCE_SEC = 0.5;

function findStream(probe: ProbeResult, sourceIndex: number): MediaStream | undefined {
  return probe.streams.find((stream) => stream.index === sourceIndex);
}

/** Planned PGS subtitles whose language has more than one planned subtitle track: only those are scanned for forced. */
export function forcedScanTargets(plan: ConversionPlan, probe: ProbeResult): number[] {
  const subtitles = plan.streams.filter(
    (stream) => stream.kind === 'subtitle' && findStream(probe, stream.sourceIndex)?.codec === PGS_CODEC,
  );
  const perLanguage = new Map<string, number>();
  for (const stream of subtitles) {
    const key = stream.language ?? '';
    perLanguage.set(key, (perLanguage.get(key) ?? 0) + 1);
  }
  return subtitles
    .filter((stream) => (perLanguage.get(stream.language ?? '') ?? 0) > 1)
    .map((stream) => stream.sourceIndex);
}

/** One ffmpeg pass writing every scanned PGS track to its own .sup file. */
export function buildSupExtractArgs(
  discPath: string,
  playlist: string,
  targets: readonly { sourceIndex: number; path: string }[],
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...playlistArgs(playlist),
    '-i',
    blurayInput(discPath),
    ...targets.flatMap((target) => ['-map', `0:${target.sourceIndex}`, '-c', 'copy', '-f', 'sup', target.path]),
  ];
}

export function buildPacketCountArgs(discPath: string, playlist: string): string[] {
  return [
    '-v',
    'error',
    ...playlistArgs(playlist),
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    blurayInput(discPath),
  ];
}

export function parsePacketCount(stdout: string): number | null {
  const value = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** ConversionPlan reduced to one encoded audio stream (one .mka side file per encoded track). */
export function sideFilePlan(plan: ConversionPlan, stream: PlannedStream): ConversionPlan {
  return { ...plan, streams: [{ ...stream, default: false }], dropped: [] };
}

export interface OutputTrack extends MkvmergeOutputTrack {
  kind: 'video' | 'audio' | 'subtitle';
}

/**
 * Pure: planned streams -> mkvmerge output tracks, video first, then the plan order. Attachments/data and dropped PIDs
 * (secondary video) are skipped; a planned stream without a PID cannot be selected in the playlist and fails the job.
 */
export function outputTracks(input: {
  plan: ConversionPlan;
  probe: ProbeResult;
  sideFiles: ReadonlyMap<number, string>;
  forced: ReadonlySet<number>;
  dropPids?: ReadonlySet<number>;
}): OutputTrack[] {
  const videoStart = input.probe.streams.find((stream) => stream.kind === 'video')?.startTimeSec ?? 0;
  const video: OutputTrack[] = [];
  const rest: OutputTrack[] = [];
  for (const planned of input.plan.streams) {
    const kind = planned.kind;
    if (kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') continue;
    const source = findStream(input.probe, planned.sourceIndex);
    if (source?.streamId == null)
      throw new AppError('unprocessable', `planned ${kind} stream ${planned.sourceIndex} has no PID in the playlist`);
    if (input.dropPids?.has(source.streamId)) continue;
    const replacementPath = input.sideFiles.get(planned.sourceIndex) ?? null;
    (kind === 'video' ? video : rest).push({
      kind,
      pid: source.streamId,
      codec: replacementPath ? null : source.codec,
      replacementPath,
      delayMs: replacementPath ? Math.round(((source.startTimeSec ?? videoStart) - videoStart) * 1000) : 0,
      language: planned.language,
      title: planned.title,
      default: planned.default,
      forced: planned.forced || input.forced.has(planned.sourceIndex),
    });
  }
  return [...video, ...rest];
}

export function secondaryVideoNotes(playlist: MplsPlaylist): string[] {
  return playlist.streams
    .filter((stream) => stream.secondaryVideo)
    .map((stream) => {
      if (stream.codingType === 0x20) return '3D (MVC) dependent view dropped, 2D base view kept';
      if (stream.codec === 'hevc') return 'Dolby Vision enhancement layer dropped, HDR10 base layer kept';
      return `secondary video (PID 0x${stream.pid.toString(16)}) dropped`;
    });
}

interface TitleWork {
  title: BdmvOutputTitle;
  index: number;
  playlist: MplsPlaylist;
  probe: ProbeResult;
  plan: ConversionPlan;
  playlistPath: string;
  tempOutput: string;
  forced: Set<number>;
  sideFiles: Map<number, string>;
  tracks: OutputTrack[];
  verification: VerificationResult | null;
}

const STEP_SPANS: Partial<Record<JobStep, readonly [number, number]>> = {
  preparing: [0, 0.1],
  encoding: [0.1, 0.5],
  muxing: [0.5, 0.8],
  verifying: [0.8, 1],
};

function reportStep(
  run: JobRunContext,
  position: { index: number; of: number },
  step: JobStep,
  fraction: number,
  extra: { speed?: number | null; etaSec?: number | null } = {},
): void {
  const [from, to] = STEP_SPANS[step] ?? [1, 1];
  const within = from + (to - from) * Math.min(1, Math.max(0, fraction));
  run.reportProgress({ progress: (position.index + within) / position.of, ...extra });
}

function ensureRan(result: RunResult, what: string, ok: (code: number | null) => boolean = (code) => code === 0): void {
  if (result.aborted) throw new AppError('internal', `${what} was cancelled`);
  if (result.timedOut) throw new AppError('internal', `${what} timed out`);
  if (!ok(result.exitCode))
    throw new AppError('internal', `${what} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-800)}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);

/** Moves a file into place, refusing to overwrite an existing target. */
export async function placeFile(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    const code = errnoCode(error) ?? '';
    if (code === 'EEXIST') throw new AppError('conflict', `output already exists: ${to}`);
    if (!NO_HARD_LINKS.has(code)) throw error;
    if (await exists(to)) throw new AppError('conflict', `output already exists: ${to}`);
    await rename(from, to);
    return;
  }
  await unlink(from);
}

export function createBdmvExecutor(
  ctx: AppContext,
  deps: { planner: DiscPlanner; log: Logger; tempRoot: string },
): JobExecutor {
  const services = ctx.services;
  const tools = () => ctx.config.get().tools;

  async function scanForcedSubtitles(
    run: JobRunContext,
    work: TitleWork,
    disc: string,
    tempDir: string,
  ): Promise<void> {
    const targets = forcedScanTargets(work.plan, work.probe).map((sourceIndex) => ({
      sourceIndex,
      path: join(tempDir, `${work.index}-s${sourceIndex}.sup`),
    }));
    if (targets.length === 0) return;
    run.log.line(`scanning ${targets.length} PGS tracks of ${work.title.playlist} for forced captions`);
    const result = await run.run({
      command: tools().ffmpeg,
      args: buildSupExtractArgs(disc, work.title.playlist, targets),
    });
    ensureRan(result, 'PGS extraction');
    for (const target of targets) {
      const counts = countForcedPgsCompositions(new Uint8Array(await readFile(target.path)));
      run.log.line(`PGS stream ${target.sourceIndex}: ${counts.forced}/${counts.compositions} forced compositions`);
      if (counts.compositions > 0 && counts.forced === counts.compositions) work.forced.add(target.sourceIndex);
      await rm(target.path, { force: true });
    }
  }

  async function encodeTitle(run: JobRunContext, work: TitleWork, disc: string, tempDir: string, of: number) {
    const encodes = work.plan.streams.filter((stream) => stream.kind === 'audio' && stream.op === 'encode');
    if (encodes.length === 0) return;
    run.setStep('encoding', `encoding ${encodes.length} audio track(s) of ${work.title.playlist}`);
    for (const [n, stream] of encodes.entries()) {
      const outputPath = join(tempDir, `${work.index}-a${stream.sourceIndex}.mka`);
      const parser = services.ffmpeg.createProgressParser(work.probe.durationSec);
      const result = await run.run({
        command: tools().ffmpeg,
        args: services.ffmpeg.buildAudioConversionArgs({
          inputPath: blurayInput(disc),
          inputOptions: playlistArgs(work.title.playlist),
          outputPath,
          probe: work.probe,
          plan: sideFilePlan(work.plan, stream),
          tagAllLanguages: true,
        }),
        onStdoutLine: (line) => {
          const update = parser.push(line);
          if (!update) return;
          reportStep(run, { index: work.index, of }, 'encoding', (n + update.progress) / encodes.length, {
            speed: update.speed,
            etaSec: update.etaSec,
          });
        },
      });
      ensureRan(result, `ffmpeg (audio stream ${stream.sourceIndex})`);
      work.sideFiles.set(stream.sourceIndex, outputPath);
    }
  }

  async function muxTitle(run: JobRunContext, work: TitleWork, movie: BdmvJobPlan['movie'], of: number) {
    run.setStep('muxing', `mkvmerge ${work.title.playlist}`);
    const identifyRun = await run.run({ command: tools().mkvmerge, args: ['-J', work.playlistPath] });
    ensureRan(identifyRun, 'mkvmerge -J', mkvmergeSucceeded);
    const secondary = new Set(work.playlist.streams.filter((s) => s.secondaryVideo).map((s) => s.pid));
    work.tracks = outputTracks({
      plan: work.plan,
      probe: work.probe,
      sideFiles: work.sideFiles,
      forced: work.forced,
      dropPids: secondary,
    });
    const name = movie.year === null ? movie.title : `${movie.title} (${movie.year})`;
    const result = await run.run({
      command: tools().mkvmerge,
      args: buildMkvmergeArgs({
        playlistPath: work.playlistPath,
        outputPath: work.tempOutput,
        playlist: work.playlist,
        identify: parseMkvmergeIdentify(JSON.parse(identifyRun.stdout)),
        tracks: work.tracks,
        title: work.title.edition ? `${name} - ${work.title.edition}` : name,
        dropSecondaryVideo: true,
      }),
      onStdoutLine: (line) => {
        const fraction = parseMkvmergeProgress(line);
        if (fraction !== null) reportStep(run, { index: work.index, of }, 'muxing', fraction);
      },
    });
    ensureRan(result, 'mkvmerge', mkvmergeSucceeded);
  }

  async function verifyTitle(run: JobRunContext, work: TitleWork, disc: string): Promise<VerificationResult> {
    run.setStep('verifying', `verifying ${basename(work.title.outputPath)}`);
    const packets = await run.run({ command: tools().ffprobe, args: buildPacketCountArgs(disc, work.title.playlist) });
    ensureRan(packets, 'ffprobe packet count');
    const expectedVideoPackets = parsePacketCount(packets.stdout);
    if (expectedVideoPackets === null)
      throw new AppError(
        'unprocessable',
        `could not count the video packets of ${work.title.playlist} (ffprobe printed "${packets.stdout.trim()}")`,
      );
    const verification = await run.verify({
      sourcePath: disc,
      outputPath: work.tempOutput,
      expectedDurationSec: work.playlist.durationSec,
      durationToleranceSec: DURATION_TOLERANCE_SEC,
      expectedStreamCount: work.tracks.length,
      compareVideoHash: false,
      expectedVideoPackets,
      decodeAudioStreams: work.tracks.flatMap((track, i) => (track.replacementPath ? [i] : [])),
      expectedChapterCount: work.playlist.chapterTimesSec.length,
      expectedLanguages: work.tracks.map((track) => ({ kind: track.kind, language: track.language })),
    });
    if (!verification.passed) {
      const failed = verification.checks.filter((check) => !check.passed).map((c) => `${c.name}: ${c.detail}`);
      throw new AppError('unprocessable', `verification failed for ${work.title.playlist}: ${failed.join('; ')}`);
    }
    return verification;
  }

  async function importIntoRadarr(run: JobRunContext, plan: BdmvJobPlan, main: TitleWork, mediaFileId: number) {
    const movieDir = dirname(main.title.outputPath);
    run.setStep('importing', `importing ${movieDir} into Radarr`);
    let movieId = plan.movie.radarrMovieId;
    try {
      if (movieId === null) {
        movieId = await services.arr.addMovie(plan.radarrInstanceId, {
          tmdbId: plan.movie.tmdbId,
          title: plan.movie.title,
          year: plan.movie.year,
          rootFolderPath: plan.rootFolderPath,
          qualityProfileId: ctx.settings.section('bdmv').qualityProfileId,
        });
        run.log.line(`added ${plan.movie.title} to Radarr (movie ${movieId})`);
      }
      await services.arr.importMovieFolder(plan.radarrInstanceId, movieDir, movieId);
      await services.jobs.addHistory({
        event: 'imported',
        path: main.title.outputPath,
        message: `imported into Radarr: ${plan.movie.title}`,
        jobId: run.job.id,
        mediaFileId,
        data: { outputPath: main.title.outputPath, arrInstanceId: plan.radarrInstanceId },
      });
      return { movieId, error: null };
    } catch (error) {
      const message = `Radarr import failed: ${errorMessage(error)}`;
      deps.log.warn('Radarr import of BDMV output failed', { jobId: run.job.id, movieDir, error });
      run.log.line(message);
      await services.jobs.addHistory({
        event: 'failed',
        path: main.title.outputPath,
        message: `${message}; the converted file stays in ${movieDir}`,
        jobId: run.job.id,
        mediaFileId,
        data: { outputPath: main.title.outputPath, arrInstanceId: plan.radarrInstanceId, error: errorMessage(error) },
      });
      const rescanned = movieId === null ? null : await rescanMovie(run, plan.radarrInstanceId, movieId);
      return { movieId, error: rescanned ? `${message}; asked Radarr to rescan the movie instead` : message };
    }
  }

  /** Fallback after a failed import: RescanMovie picks the file up from the movie folder once Radarr is back. */
  async function rescanMovie(run: JobRunContext, instanceId: number, movieId: number): Promise<boolean> {
    try {
      await services.arr.rescan({ instanceId, kind: 'radarr', itemId: movieId, fileId: null });
      run.log.line(`asked Radarr to rescan movie ${movieId}`);
      return true;
    } catch (error) {
      deps.log.warn('Radarr rescan after a failed BDMV import failed too', { jobId: run.job.id, movieId, error });
      run.log.line(`Radarr rescan failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async function finish(
    run: JobRunContext,
    plan: BdmvJobPlan,
    work: TitleWork[],
    mediaFileId: number,
    skipped: readonly string[],
  ) {
    const main = work[0] as TitleWork;
    const imported = await importIntoRadarr(run, plan, main, mediaFileId);
    const reason = `converted to ${main.title.outputPath}`;
    await services.media.recordJobResult(mediaFileId, { status: 'compatible', reason, lastJobId: run.job.id });
    await services.notifier.fileChanged({
      kind: 'created',
      localPath: main.title.outputPath,
      mediaFileId,
      arr:
        imported.movieId === null
          ? null
          : { instanceId: plan.radarrInstanceId, kind: 'radarr', itemId: imported.movieId, fileId: null },
      jobId: run.job.id,
    });
    const after = await services.probe
      .probe(main.title.outputPath, { signal: run.signal })
      .then((probe): MediaStream[] => probe.streams)
      .catch((error: unknown) => {
        deps.log.warn('could not probe BDMV output', { path: main.title.outputPath, error });
        return null;
      });
    let bytesAfter = 0;
    for (const item of work) bytesAfter += (await stat(item.title.outputPath)).size;
    const lostFeatures = [
      ...new Set(work.flatMap((item) => [...item.plan.lostFeatures, ...secondaryVideoNotes(item.playlist)])),
    ];
    const extras = work.length > 1 ? [`${work.length - 1} more title(s) written`] : [];
    run.setStep('done', reason);
    return {
      outputPath: main.title.outputPath,
      plan: main.plan,
      after,
      lostFeatures,
      verification: main.verification,
      bytesAfter,
      recycleBinEntryId: null,
      message: [reason, ...extras, ...skipped, ...(imported.error ? [imported.error] : [])].join('; '),
    } satisfies JobOutcome;
  }

  /**
   * Moves every verified temp file into the library without overwriting: link + unlink fails with EEXIST when a file
   * appeared meanwhile (rename where hard links are unsupported). A failure removes the outputs this run placed.
   */
  async function placeOutputs(run: JobRunContext, work: readonly TitleWork[]): Promise<void> {
    for (const item of work) await mkdir(dirname(item.title.outputPath), { recursive: true });
    const placed: string[] = [];
    try {
      for (const item of work) {
        await placeFile(item.tempOutput, item.title.outputPath);
        placed.push(item.title.outputPath);
        run.log.line(`wrote ${item.title.outputPath}`);
      }
    } catch (error) {
      for (const path of placed) {
        await rm(path, { force: true }).catch((cause: unknown) =>
          deps.log.error('could not remove a partially placed BDMV output', { path, error: cause }),
        );
        run.log.line(`removed ${path} again`);
      }
      throw error;
    }
  }

  return async (run) => {
    const mediaFileId = run.job.mediaFileId;
    if (mediaFileId == null) throw new AppError('unprocessable', `job ${run.job.id} has no media file`);
    const isoReader = createIsoReader({
      sevenZip: tools().sevenZip,
      run: (options) => run.run(options),
      tempRoot: deps.tempRoot,
    });

    run.setStep('preparing', 're-analysing the disc');
    const disc = loadDiscRow(ctx, mediaFileId);
    const discPath = disc.row.path;
    const fresh = await deps.planner.plan(disc, 'execute', run.signal);
    const plan = fresh.evaluation.plan;
    if (fresh.evaluation.status !== 'needs_work' || !plan || !fresh.analysis)
      throw new AppError('unprocessable', fresh.evaluation.reason ?? 'the disc no longer needs conversion');
    const playlists = fresh.analysis.playlists;
    run.log.section(`BDMV ${discPath} -> ${plan.titles.map((title) => title.outputPath).join(', ')}`);
    for (const title of plan.titles) {
      if (await exists(title.outputPath)) throw new AppError('conflict', `output already exists: ${title.outputPath}`);
    }

    const tempDir = join(plan.rootFolderPath, `${TEMP_FILE_MARKER}-${run.job.id}`);
    await run.setTempPath(tempDir);
    let finished = false;
    try {
      await mkdir(tempDir, { recursive: true });
      await run.ensureFreeSpace(plan.rootFolderPath, plan.extractBytes + plan.estimatedOutputBytes);
      const library = await services.libraries.get(disc.row.libraryId);
      const profile = await services.rules.effectiveProfileForLibrary(disc.row.libraryId);
      if (!profile) throw new AppError('unprocessable', 'the library has no player profile');
      const of = plan.titles.length;

      const work: TitleWork[] = [];
      const skipped: string[] = [];
      for (const [index, title] of plan.titles.entries()) {
        const playlist = playlists.find((candidate) => candidate.name === title.playlist);
        if (!playlist) throw new AppError('unprocessable', `playlist ${title.playlist} not found on the disc`);
        const probe =
          index === 0 && fresh.probe
            ? fresh.probe
            : withPlaylistLanguages(
                await services.probe.probe(discPath, { playlist: title.playlist, signal: run.signal }),
                playlist,
              );
        const conversion =
          index === 0 && plan.audioPlan
            ? plan.audioPlan
            : services.rules.plan({ probe, profile, library, originalLanguage: disc.row.originalLanguage });
        if (conversion.action === 'blocked') {
          const why = `blocked: ${conversion.reasons.join('; ') || 'the device profile cannot play it'}`;
          if (title.role !== 'extra') throw new AppError('unprocessable', `${title.role} ${title.playlist} is ${why}`);
          skipped.push(`extra ${title.playlist} skipped (${why})`);
          run.log.line(`extra ${title.playlist} skipped: ${why}`);
          continue;
        }
        const item: TitleWork = {
          title,
          index: work.length,
          playlist,
          probe,
          plan: conversion,
          playlistPath:
            plan.sourceKind === 'iso'
              ? await isoReader.extractForMux(discPath, title.playlist, join(tempDir, `disc-${index}`), run.signal)
              : join(discPath, 'BDMV', 'PLAYLIST', title.playlist),
          tempOutput: join(tempDir, `${index}-${basename(title.playlist, '.mpls')}.mkv`),
          forced: new Set(),
          sideFiles: new Map(),
          tracks: [],
          verification: null,
        };
        await scanForcedSubtitles(run, item, discPath, tempDir);
        reportStep(run, { index, of }, 'preparing', 1);
        work.push(item);
      }
      const titles = work.length;

      for (const item of work) {
        await encodeTitle(run, item, discPath, tempDir, titles);
        await muxTitle(run, item, plan.movie, titles);
        item.verification = await verifyTitle(run, item, discPath);
        reportStep(run, { index: item.index, of: titles }, 'verifying', 1);
      }

      await placeOutputs(run, work);
      finished = true;
      await rm(tempDir, { recursive: true, force: true });
      await run.setTempPath(null);
      return await finish(run, plan, work, mediaFileId, skipped);
    } finally {
      if (!finished) {
        await rm(tempDir, { recursive: true, force: true }).catch((error: unknown) =>
          deps.log.error('could not delete BDMV temp dir', { tempDir, error }),
        );
        await run.setTempPath(null);
      }
    }
  };
}
