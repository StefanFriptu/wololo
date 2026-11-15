import { z } from 'zod';
import type { StreamKind, VerificationCheck, VerificationResult } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';

export const DEFAULT_DURATION_TOLERANCE_SEC = 0.1;
const EPSILON = 1e-9;

export interface MediaFacts {
  durationSec: number | null;
  streams: { index: number; kind: StreamKind; language: string | null }[];
  /** Video streams that are not attached pictures: what `-map 0:V` hashes. */
  videoStreamCount: number;
  chapterCount: number;
}

const STREAM_KINDS: Readonly<Record<string, StreamKind>> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
};

const numeric = z.union([z.number(), z.string()]).transform((value) => Number(value));

const ffprobeSchema = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int(),
        codec_type: z.string().optional(),
        tags: z.record(z.string(), z.string()).optional(),
        disposition: z.record(z.string(), z.number()).optional(),
      }),
    )
    .default([]),
  format: z.object({ duration: numeric.optional() }).default({}),
  chapters: z.array(z.unknown()).default([]),
});

function languageTag(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  const key = Object.keys(tags).find((name) => name.toLowerCase() === 'language');
  return key ? normalizeLanguage(tags[key]) : null;
}

/** ffprobe -show_streams -show_format -show_chapters JSON -> the facts verification compares. Throws on foreign shapes. */
export function parseMediaFacts(raw: unknown): MediaFacts {
  const parsed = ffprobeSchema.parse(raw);
  const duration = parsed.format.duration;
  return {
    durationSec: duration !== undefined && Number.isFinite(duration) ? duration : null,
    streams: parsed.streams.map((stream) => ({
      index: stream.index,
      kind: STREAM_KINDS[stream.codec_type ?? ''] ?? 'data',
      language: languageTag(stream.tags),
    })),
    videoStreamCount: parsed.streams.filter(
      (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    ).length,
    chapterCount: parsed.chapters.length,
  };
}

/** `ffmpeg -f streamhash -hash md5` output ("0,v,MD5=abc...") -> hashes in stream order. */
export function parseStreamHashes(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(','))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0] ?? ''))
    .map((parts) => parts.slice(2).join(','));
}

export function checkOutputExists(exists: boolean, path: string): VerificationCheck {
  return { name: 'output_exists', passed: exists, detail: exists ? path : `${path} is missing` };
}

export function checkDuration(
  expectedSec: number,
  actualSec: number | null,
  toleranceSec = DEFAULT_DURATION_TOLERANCE_SEC,
): VerificationCheck {
  if (actualSec === null) return { name: 'duration', passed: false, detail: 'output has no duration' };
  const diff = Math.abs(actualSec - expectedSec);
  return {
    name: 'duration',
    passed: diff <= toleranceSec + EPSILON,
    detail: `${actualSec.toFixed(3)} s vs ${expectedSec.toFixed(3)} s (diff ${(diff * 1000).toFixed(0)} ms, max ${(toleranceSec * 1000).toFixed(0)} ms)`,
  };
}

export function checkStreamCount(expected: number, actual: number): VerificationCheck {
  return { name: 'stream_count', passed: actual === expected, detail: `${actual} streams, expected ${expected}` };
}

export function checkVideoHashes(
  source: readonly string[],
  output: readonly string[],
  outputVideoStreams: number,
): VerificationCheck {
  if (output.length !== outputVideoStreams)
    return {
      name: 'video_checksum',
      passed: false,
      detail: `${output.length} video hashes for ${outputVideoStreams} video streams in the output`,
    };
  if (source.length === 0 && output.length === 0)
    return { name: 'video_checksum', passed: true, detail: 'no video stream' };
  const passed = source.length === output.length && source.every((hash, i) => hash === output[i]);
  return {
    name: 'video_checksum',
    passed,
    detail: passed
      ? `unchanged (${source.join(', ')})`
      : `source ${source.join(', ') || 'none'} vs output ${output.join(', ') || 'none'}`,
  };
}

export function checkVideoPackets(expected: number, actual: number | null): VerificationCheck {
  return {
    name: 'video_packets',
    passed: actual === expected,
    detail: `${actual ?? 'unknown'} packets, expected ${expected}`,
  };
}

export function checkAudioDecode(
  streams: readonly number[],
  result: { exitCode: number | null; errors: readonly string[] },
): VerificationCheck {
  const passed = result.exitCode === 0 && result.errors.length === 0;
  const target = `stream${streams.length === 1 ? '' : 's'} ${streams.join(', ')}`;
  return {
    name: 'audio_decode',
    passed,
    detail: passed
      ? `${target} decoded without errors`
      : `${target}: exit ${result.exitCode ?? 'signal'}${result.errors.length ? `, ${result.errors.slice(0, 3).join(' | ')}` : ''}`,
  };
}

export function checkChapters(expected: number, actual: number): VerificationCheck {
  return { name: 'chapters', passed: actual === expected, detail: `${actual} chapters, expected ${expected}` };
}

export function checkLanguages(
  expected: readonly { kind: StreamKind; language: string | null }[],
  actual: readonly { kind: StreamKind; language: string | null }[],
): VerificationCheck {
  const mismatches = expected.flatMap((want, i) => {
    const got = actual[i];
    const wantLanguage = normalizeLanguage(want.language);
    const gotLanguage = got ? normalizeLanguage(got.language) : null;
    if (got && got.kind === want.kind && gotLanguage === wantLanguage) return [];
    return [`#${i} ${got?.kind ?? 'missing'} ${gotLanguage ?? 'und'}, expected ${want.kind} ${wantLanguage ?? 'und'}`];
  });
  return {
    name: 'languages',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? `${expected.length} streams tagged as planned` : mismatches.join('; '),
  };
}

export function summarizeVerification(checks: VerificationCheck[]): VerificationResult {
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks };
}

export function failedChecksMessage(result: VerificationResult): string {
  return result.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.detail}`)
    .join('; ');
}
