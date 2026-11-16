import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Services } from '../../app/context.ts';
import type { JobExecutor, JobOutcome, JobRunContext } from '../../contracts/jobs.ts';
import { AppError, errorMessage } from '../../core/errors.ts';
import type { Logger } from '../../core/logger.ts';
import type { MediaFileDetail } from '../../shared/api-types.ts';
import type { ConversionPlan, MediaStream, ProbeResult } from '../../shared/domain.ts';
import { exceedsNameMax, isTempPath, outputPathFor, tempPathFor } from './paths.ts';
import { NODE_REPLACE_FS, type ReplaceFs, replaceOriginal } from './replace.ts';
import { failedChecksMessage } from './verification.ts';

export interface AudioExecutorDeps {
  services: Pick<Services, 'probe' | 'media' | 'libraries' | 'rules' | 'ffmpeg' | 'recycleBin' | 'notifier'>;
  ffmpegPath: () => string;
  recycleBinEnabled: () => boolean;
  /** Fails when the recycle bin for this path cannot be created or sits on another filesystem. */
  checkRecycleBin: (sourcePath: string) => Promise<void>;
  /** Stores the plan and source streams as soon as they are known, so a running or failed job shows them. */
  recordPlan: (jobId: number, plan: ConversionPlan, before: MediaStream[]) => void;
  /** Id of an earlier running job that writes the same output path (a same-stem sibling), else null. */
  runningJobForOutput: (jobId: number, outputPath: string) => number | null;
  log: Logger;
  fs?: ReplaceFs;
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function encodedAudioOutputIndexes(plan: ConversionPlan): number[] {
  return plan.streams.flatMap((stream, index) => (stream.kind === 'audio' && stream.op === 'encode' ? [index] : []));
}

function describePlan(plan: ConversionPlan, probe: ProbeResult): string {
  const lines = plan.streams.flatMap((stream) => {
    if (!stream.encode) return [];
    const source = probe.streams.find((candidate) => candidate.index === stream.sourceIndex)?.codec ?? stream.codec;
    const { codec, channelLayout, bitrateKbps } = stream.encode;
    return [`${source} -> ${codec} ${channelLayout} ${bitrateKbps} kbps`];
  });
  return lines.length > 0 ? lines.join(', ') : `remuxed (${plan.dropped.length} streams dropped)`;
}

async function runFfmpeg(
  ctx: JobRunContext,
  deps: AudioExecutorDeps,
  args: string[],
  probe: ProbeResult,
): Promise<void> {
  const parser = deps.services.ffmpeg.createProgressParser(probe.durationSec);
  const result = await ctx.run({
    command: deps.ffmpegPath(),
    args,
    onStdoutLine: (line) => {
      const update = parser.push(line);
      if (update)
        ctx.reportProgress({
          progress: update.progress,
          speed: update.speed,
          etaSec: update.etaSec,
          outTimeSec: update.outTimeSec,
        });
    },
  });
  if (result.aborted || ctx.signal.aborted) throw new AppError('conflict', 'job was aborted');
  if (result.exitCode !== 0) {
    const lastLine = result.stderr.trim().split(/\r?\n/).at(-1) ?? '';
    throw new AppError('upstream', `ffmpeg exited with ${result.exitCode ?? result.signalCode}: ${lastLine}`);
  }
}

async function afterReplace(
  ctx: JobRunContext,
  deps: AudioExecutorDeps,
  media: MediaFileDetail,
  outputPath: string,
): Promise<{ after: ProbeResult | null }> {
  const { services } = deps;
  const jobId = ctx.job.id;
  const warn = (what: string, error: unknown) => {
    ctx.log.line(`${what} failed: ${errorMessage(error)}`);
    deps.log.warn(`${what} failed after replace`, { jobId, path: outputPath, error: errorMessage(error) });
  };
  let after: ProbeResult | null = null;
  try {
    after = await services.probe.probe(outputPath);
  } catch (error) {
    warn('probe of the new file', error);
  }
  try {
    await services.media.recordJobResult(media.id, {
      status: 'compatible',
      reason: null,
      lastJobId: jobId,
      ...(outputPath === media.path ? {} : { path: outputPath }),
      probe: after,
    });
  } catch (error) {
    warn('media.recordJobResult', error);
  }
  try {
    await services.notifier.fileChanged({
      kind: 'replaced',
      localPath: outputPath,
      mediaFileId: media.id,
      arr: media.arr,
      jobId,
    });
  } catch (error) {
    warn('notifier.fileChanged', error);
  }
  return { after };
}

export function createAudioExecutor(deps: AudioExecutorDeps): JobExecutor {
  const fs = deps.fs ?? NODE_REPLACE_FS;
  return async (ctx) => {
    const { services } = deps;
    const { job } = ctx;
    if (job.mediaFileId === null) throw new AppError('unprocessable', 'the media file of this job was removed');
    const sourcePath = job.sourcePath;
    if (isTempPath(sourcePath))
      throw new AppError('unprocessable', `refusing to convert a Wololo temp file: ${sourcePath}`);
    if (!existsSync(sourcePath)) throw new AppError('not_found', `source file is missing: ${sourcePath}`);

    ctx.setStep('preparing', 'probing source and planning');
    const media = await services.media.get(job.mediaFileId);
    const expectedSource = fs.stat(sourcePath);
    const probe = await services.probe.probe(sourcePath, { signal: ctx.signal });
    const library = await services.libraries.get(media.libraryId);
    const profile = await services.rules.effectiveProfileForLibrary(media.libraryId);
    const plan = services.rules.plan({ probe, profile, library, originalLanguage: media.originalLanguage });
    deps.recordPlan(job.id, plan, probe.streams);
    ctx.log.line(`plan: ${plan.action}; ${plan.reasons.join('; ') || 'no reasons'}`);

    if (plan.action === 'skip' || plan.action === 'blocked') {
      const blocked = plan.action === 'blocked' ? `blocked: ${plan.reasons.join('; ')}` : null;
      await services.media.recordJobResult(media.id, {
        status: blocked ? 'blocked' : 'compatible',
        reason: blocked,
        lastJobId: job.id,
        probe,
      });
      return {
        outputPath: null,
        after: null,
        lostFeatures: [],
        plan,
        verification: null,
        bytesAfter: null,
        recycleBinEntryId: null,
        message: blocked ? `${blocked}; nothing written` : 'already compatible, nothing written',
      } satisfies JobOutcome;
    }

    const tempPath = tempPathFor(sourcePath, job.id);
    const outputPath = outputPathFor(sourcePath);
    if (exceedsNameMax(outputPath))
      throw new AppError('unprocessable', `output file name is longer than 255 bytes: ${outputPath}`);
    const sibling = deps.runningJobForOutput(job.id, outputPath);
    if (sibling !== null) throw new AppError('conflict', `job ${sibling} is already writing ${outputPath}`);
    if (outputPath !== sourcePath && existsSync(outputPath))
      throw new AppError('conflict', `output path already exists: ${outputPath}`);
    await ctx.ensureFreeSpace(dirname(sourcePath), plan.estimatedOutputBytes ?? probe.sizeBytes);
    if (deps.recycleBinEnabled()) await deps.checkRecycleBin(sourcePath);

    await ctx.setTempPath(tempPath);
    rmSync(tempPath, { force: true });
    ctx.setStep(plan.action === 'convert' ? 'encoding' : 'muxing', describePlan(plan, probe));
    const args = services.ffmpeg.buildAudioConversionArgs({ inputPath: sourcePath, outputPath: tempPath, probe, plan });
    await runFfmpeg(ctx, deps, args, probe);

    ctx.setStep('verifying');
    const verification = await ctx.verify({
      sourcePath,
      outputPath: tempPath,
      expectedDurationSec: probe.durationSec,
      expectedStreamCount: plan.streams.length,
      compareVideoHash: true,
      decodeAudioStreams: encodedAudioOutputIndexes(plan),
      expectedChapterCount: probe.chapterCount,
      expectedLanguages: plan.streams.map((stream) => ({ kind: stream.kind, language: stream.language })),
    });
    for (const check of verification.checks)
      ctx.log.line(`verify ${check.name}: ${check.passed ? 'ok' : 'FAILED'} (${check.detail})`);
    if (!verification.passed)
      throw new AppError('unprocessable', `verification failed: ${failedChecksMessage(verification)}`);
    if (ctx.signal.aborted) throw new AppError('conflict', 'job was aborted');

    ctx.setStep('replacing', outputPath === sourcePath ? sourcePath : `${sourcePath} -> ${outputPath}`);
    const { recycleBinEntryId } = await replaceOriginal({
      sourcePath,
      expectedSource,
      tempPath,
      outputPath,
      recycle: deps.recycleBinEnabled()
        ? async () => {
            const { entry, mode } = await services.recycleBin.recycleForReplace(sourcePath, {
              jobId: job.id,
              mediaFileId: job.mediaFileId,
            });
            ctx.log.line(`original kept in the recycle bin (${mode}): ${entry.recyclePath}`);
            return { entryId: entry.id, mode };
          }
        : null,
      fs,
      warn: (message) => ctx.log.line(message),
    });
    await ctx.setTempPath(null);
    ctx.setStep('notifying');

    const { after } = await afterReplace(ctx, deps, media, outputPath);
    return {
      outputPath,
      plan,
      after: after?.streams ?? null,
      lostFeatures: plan.lostFeatures,
      verification,
      bytesAfter: after?.sizeBytes ?? sizeOf(outputPath),
      recycleBinEntryId,
      message: `converted: ${describePlan(plan, probe)}`,
    } satisfies JobOutcome;
  };
}
