import { existsSync } from 'node:fs';
import type { JobRunContext, VerifyRequest } from '../../contracts/jobs.ts';
import { errorMessage } from '../../core/errors.ts';
import type { VerificationCheck, VerificationResult } from '../../shared/domain.ts';
import {
  checkAudioDecode,
  checkChapters,
  checkDuration,
  checkLanguages,
  checkOutputExists,
  checkStreamCount,
  checkVideoHashes,
  checkVideoPackets,
  checkVideoTimeline,
  type MediaFacts,
  parseMediaFacts,
  parseStreamHashes,
  parseVideoPackets,
  summarizeVerification,
  type VideoPacket,
} from './verification.ts';

export interface VerifierDeps {
  run: JobRunContext['run'];
  ffmpeg: string;
  ffprobe: string;
}

/**
 * Independent of the probe module on purpose: reads the output with its own ffprobe call, hashes video packets with
 * ffmpeg's streamhash muxer and fully decodes new audio streams. Every check runs; any failure fails the result.
 */
export function createVerifier(deps: VerifierDeps): (request: VerifyRequest) => Promise<VerificationResult> {
  const readFacts = async (path: string): Promise<MediaFacts> => {
    const result = await deps.run({
      command: deps.ffprobe,
      args: ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path],
    });
    if (result.exitCode !== 0) throw new Error(`ffprobe exited with ${result.exitCode}: ${result.stderr.trim()}`);
    return parseMediaFacts(JSON.parse(result.stdout));
  };

  const videoHashes = async (path: string): Promise<string[]> => {
    const result = await deps.run({
      command: deps.ffmpeg,
      args: [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:V?',
        '-c',
        'copy',
        '-f',
        'streamhash',
        '-hash',
        'md5',
        '-',
      ],
    });
    if (result.exitCode !== 0) throw new Error(`streamhash of ${path} exited with ${result.exitCode}`);
    return parseStreamHashes(result.stdout);
  };

  const isMpegTs = async (path: string): Promise<boolean> => {
    const result = await deps.run({
      command: deps.ffprobe,
      args: ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', path],
    });
    if (result.exitCode !== 0) throw new Error(`ffprobe of ${path} exited with ${result.exitCode}`);
    return result.stdout.trim().split(',').includes('mpegts');
  };

  const videoTimeline = async (path: string): Promise<VideoPacket[]> => {
    const result = await deps.run({
      command: deps.ffprobe,
      args: [
        '-v',
        'error',
        '-select_streams',
        'V',
        '-show_entries',
        'packet=stream_index,pts_time,flags',
        '-of',
        'csv=p=0',
        path,
      ],
    });
    if (result.exitCode !== 0) throw new Error(`packet list of ${path} exited with ${result.exitCode}`);
    return parseVideoPackets(result.stdout);
  };

  const compareVideo = async (request: VerifyRequest, outputVideoStreams: number): Promise<VerificationCheck> => {
    if (await isMpegTs(request.sourcePath)) {
      const [source, output] = await Promise.all([
        videoTimeline(request.sourcePath),
        videoTimeline(request.outputPath),
      ]);
      return checkVideoTimeline(source, output, outputVideoStreams);
    }
    const [source, output] = await Promise.all([videoHashes(request.sourcePath), videoHashes(request.outputPath)]);
    return checkVideoHashes(source, output, outputVideoStreams);
  };

  const videoPackets = async (path: string): Promise<number | null> => {
    const result = await deps.run({
      command: deps.ffprobe,
      args: [
        '-v',
        'error',
        '-select_streams',
        'V:0',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets',
        '-of',
        'csv=p=0',
        path,
      ],
    });
    const value = Number.parseInt(result.stdout.trim(), 10);
    return result.exitCode === 0 && Number.isFinite(value) ? value : null;
  };

  const decodeAudio = async (path: string, streams: number[]) => {
    const maps = streams.flatMap((index) => ['-map', `0:${index}`]);
    const result = await deps.run({
      command: deps.ffmpeg,
      args: ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', path, ...maps, '-f', 'null', '-'],
    });
    const errors = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { exitCode: result.exitCode, errors };
  };

  return async (request) => {
    const exists = existsSync(request.outputPath);
    const checks: VerificationCheck[] = [checkOutputExists(exists, request.outputPath)];
    if (!exists) return summarizeVerification(checks);

    let facts: MediaFacts;
    try {
      facts = await readFacts(request.outputPath);
    } catch (error) {
      checks.push({ name: 'output_readable', passed: false, detail: `cannot read output: ${errorMessage(error)}` });
      return summarizeVerification(checks);
    }
    checks.push(checkDuration(request.expectedDurationSec, facts.durationSec, request.durationToleranceSec));
    checks.push(checkStreamCount(request.expectedStreamCount, facts.streams.length));

    if (request.compareVideoHash) {
      try {
        checks.push(await compareVideo(request, facts.videoStreamCount));
      } catch (error) {
        checks.push({ name: 'video_checksum', passed: false, detail: errorMessage(error) });
      }
    }
    if (request.expectedVideoPackets !== undefined)
      checks.push(checkVideoPackets(request.expectedVideoPackets, await videoPackets(request.outputPath)));
    if (request.decodeAudioStreams.length > 0)
      checks.push(
        checkAudioDecode(request.decodeAudioStreams, await decodeAudio(request.outputPath, request.decodeAudioStreams)),
      );
    if (request.expectedChapterCount !== undefined)
      checks.push(checkChapters(request.expectedChapterCount, facts.chapterCount));
    if (request.expectedLanguages !== undefined) checks.push(checkLanguages(request.expectedLanguages, facts.streams));
    return summarizeVerification(checks);
  };
}
