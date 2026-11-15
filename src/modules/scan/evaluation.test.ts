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

test('summarizeProbe - first real video codec, unique audio codecs, subtitle languages', () => {
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
  ['blocked', ['video vc1 not supported'], 'failed', 'blocked: video vc1 not supported'],
] as const)('statusFromPlan - %s %j -> %s', (action, reasons, status, reason) => {
  expect(statusFromPlan(plan(action, [...reasons]))).toEqual({ status, reason });
});

test.each([
  ['compatible', 'skip', 'compatible'],
  ['needs_work', 'convert', 'dry_run'],
  ['failed', 'blocked', 'blocked'],
  ['failed', null, 'failed'],
  ['ignored', 'convert', 'ignored'],
  ['ignored', 'blocked', 'ignored'],
  ['processing', 'convert', 'queued'],
  ['pending', null, 'failed'],
] as const)('checkActionFor - %s / %s -> %s', (status, planAction, expected) => {
  expect(checkActionFor(status as MediaFileStatus, planAction)).toBe(expected);
});
