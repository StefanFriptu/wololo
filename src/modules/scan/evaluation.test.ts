import { expect, test } from 'bun:test';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import type { ConversionPlan, MediaFileStatus, PlanAction } from '../../shared/domain.ts';
import { checkActionFor, statusFromPlan, summarizeProbe } from './evaluation.ts';

function plan(action: PlanAction, reasons: string[] = []): ConversionPlan {
  return {
    action,
    reasons,
    failingCodecs: [],
    streams: [],
    dropped: [],
    lostFeatures: [],
    videoNotes: [],
    estimatedOutputBytes: null,
    rulesKey: 'k',
  };
}

test('summarizeProbe - first real video codec, unique audio and stream codecs, subtitle languages', () => {
  const probe = probeResult([
    videoStream({ codec: 'mjpeg', attachedPicture: true }),
    videoStream({ codec: 'hevc' }),
    audioStream({ codec: 'truehd' }),
    audioStream({ codec: 'ac3' }),
    audioStream({ codec: 'truehd', language: 'ger' }),
    subtitleStream({ language: 'eng' }),
    subtitleStream({ language: null }),
    subtitleStream({ language: 'eng', forced: true }),
    subtitleStream({ language: 'spa' }),
  ]);
  expect(summarizeProbe(probe)).toEqual({
    videoCodec: 'hevc',
    audioCodecs: ['truehd', 'ac3'],
    streamCodecs: ['mjpeg', 'hevc', 'truehd', 'ac3', 'subrip'],
    subtitleLanguages: ['eng', 'spa'],
  });
});

test('summarizeProbe - audio-only file has no video codec', () => {
  expect(summarizeProbe(probeResult([audioStream()])).videoCodec).toBeNull();
});

test.each([
  ['skip', [], 'compatible', null],
  ['convert', ['dts (eng, 5.1) not decoded by profile'], 'needs_work', 'dts (eng, 5.1) not decoded by profile'],
  ['remux', ['a', 'b'], 'needs_work', 'a; b'],
  ['remux', [], 'needs_work', null],
  ['blocked', ['video vc1 not supported'], 'blocked', 'blocked: video vc1 not supported'],
] as const)('statusFromPlan - %s %j -> %s', (action, reasons, status, reason) => {
  expect(statusFromPlan(plan(action, [...reasons]))).toEqual({ status, reason });
});

test.each([
  ['compatible', 'compatible'],
  ['needs_work', 'dry_run'],
  ['blocked', 'blocked'],
  ['failed', 'failed'],
  ['ignored', 'ignored'],
  ['processing', 'queued'],
  ['pending', 'failed'],
] as const)('checkActionFor - %s -> %s', (status, expected) => {
  expect(checkActionFor(status as MediaFileStatus)).toBe(expected);
});
