import { expect, test } from 'bun:test';
import {
  checkAudioDecode,
  checkChapters,
  checkDuration,
  checkLanguages,
  checkOutputExists,
  checkStreamCount,
  checkVideoHashes,
  checkVideoPackets,
  failedChecksMessage,
  parseMediaFacts,
  parseStreamHashes,
  summarizeVerification,
} from './verification.ts';

test.each([
  [5400, 5400.05, true],
  [5400, 5400.1, true],
  [5400, 5399.9, true],
  [5400, 5400.1001, false],
  [5400, 5399.85, false],
  [3, 3.032, true],
])('checkDuration - expected %d s, got %d s passes: %p', (expected, actual, passed) => {
  expect(checkDuration(expected, actual).passed).toBe(passed);
});

test('checkDuration - custom tolerance', () => {
  expect(checkDuration(10, 10.4, 0.5).passed).toBe(true);
  expect(checkDuration(10, 10.4).passed).toBe(false);
});

test('checkDuration - missing output duration fails', () => {
  expect(checkDuration(10, null)).toEqual({ name: 'duration', passed: false, detail: 'output has no duration' });
});

test.each([
  [3, 3, true],
  [3, 2, false],
  [3, 4, false],
])('checkStreamCount - expected %d, got %d passes: %p', (expected, actual, passed) => {
  expect(checkStreamCount(expected, actual).passed).toBe(passed);
});

test.each([
  [['MD5=a'], ['MD5=a'], 1, true],
  [['MD5=a', 'MD5=b'], ['MD5=a', 'MD5=b'], 2, true],
  [['MD5=a'], ['MD5=b'], 1, false],
  [['MD5=a'], [], 0, false],
  [[], ['MD5=a'], 1, false],
  [['MD5=a', 'MD5=b'], ['MD5=b', 'MD5=a'], 2, false],
  [[], [], 0, true],
  [[], [], 1, false],
  [['MD5=a'], ['MD5=a'], 2, false],
])('checkVideoHashes - %j vs %j with %d output video streams passes: %p', (source, output, streams, passed) => {
  expect(checkVideoHashes(source, output, streams).passed).toBe(passed);
});

test('checkVideoHashes - no hashes for a file that has video never passes as "no video stream"', () => {
  expect(checkVideoHashes([], [], 1)).toEqual({
    name: 'video_checksum',
    passed: false,
    detail: '0 video hashes for 1 video streams in the output',
  });
});

test.each([
  [100, 100, true],
  [100, 99, false],
  [100, null, false],
])('checkVideoPackets - expected %d, got %p passes: %p', (expected, actual, passed) => {
  expect(checkVideoPackets(expected, actual).passed).toBe(passed);
});

test.each([
  [{ exitCode: 0, errors: [] }, true],
  [{ exitCode: 0, errors: ['[ac3 @ 0x1] error decoding frame'] }, false],
  [{ exitCode: 1, errors: [] }, false],
  [{ exitCode: null, errors: [] }, false],
])('checkAudioDecode - %o passes: %p', (result, passed) => {
  expect(checkAudioDecode([1], result).passed).toBe(passed);
});

test.each([
  [3, 3, true],
  [0, 0, true],
  [3, 0, false],
])('checkChapters - expected %d, got %d passes: %p', (expected, actual, passed) => {
  expect(checkChapters(expected, actual).passed).toBe(passed);
});

test.each([
  [[{ kind: 'audio', language: 'ger' }], [{ kind: 'audio', language: 'ger' }], true],
  [[{ kind: 'audio', language: 'ger' }], [{ kind: 'audio', language: 'deu' }], true],
  [[{ kind: 'audio', language: null }], [{ kind: 'audio', language: 'und' }], true],
  [[{ kind: 'audio', language: 'eng' }], [{ kind: 'audio', language: null }], false],
  [[{ kind: 'audio', language: 'eng' }], [{ kind: 'subtitle', language: 'eng' }], false],
  [[{ kind: 'audio', language: 'eng' }], [], false],
] as const)('checkLanguages - %j vs %j passes: %p', (expected, actual, passed) => {
  expect(checkLanguages(expected, actual).passed).toBe(passed);
});

test('checkOutputExists - reports the missing path', () => {
  expect(checkOutputExists(false, '/x.mkv')).toEqual({
    name: 'output_exists',
    passed: false,
    detail: '/x.mkv is missing',
  });
});

test('summarizeVerification - every check must pass, and an empty list never passes', () => {
  const ok = checkStreamCount(1, 1);
  const bad = checkStreamCount(1, 2);
  expect(summarizeVerification([ok]).passed).toBe(true);
  expect(summarizeVerification([ok, bad]).passed).toBe(false);
  expect(summarizeVerification([]).passed).toBe(false);
  expect(failedChecksMessage(summarizeVerification([ok, bad]))).toBe('stream_count: 2 streams, expected 1');
});

test('parseStreamHashes - one hash per stream line, ignoring noise', () => {
  const output = '#software: Lavf\n0,v,MD5=f86f626ddae72dcb6ebe4dcf5533b3a0\n1,v,MD5=00ff\n\n';
  expect(parseStreamHashes(output)).toEqual(['MD5=f86f626ddae72dcb6ebe4dcf5533b3a0', 'MD5=00ff']);
  expect(parseStreamHashes('')).toEqual([]);
});

test('parseMediaFacts - maps duration, kinds, normalised languages and chapters', () => {
  const facts = parseMediaFacts({
    streams: [
      { index: 0, codec_type: 'video', tags: {} },
      { index: 5, codec_type: 'video', disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'audio', tags: { language: 'deu' } },
      { index: 2, codec_type: 'subtitle', tags: { LANGUAGE: 'en' } },
      { index: 3, codec_type: 'attachment' },
      { index: 4, codec_type: 'data', tags: { language: 'und' } },
    ],
    format: { duration: '3.005000' },
    chapters: [{}, {}, {}],
  });
  expect(facts).toEqual({
    durationSec: 3.005,
    streams: [
      { index: 0, kind: 'video', language: null },
      { index: 5, kind: 'video', language: null },
      { index: 1, kind: 'audio', language: 'ger' },
      { index: 2, kind: 'subtitle', language: 'eng' },
      { index: 3, kind: 'attachment', language: null },
      { index: 4, kind: 'data', language: null },
    ],
    videoStreamCount: 1,
    chapterCount: 3,
  });
});

test('parseMediaFacts - missing duration is null, missing arrays are empty', () => {
  expect(parseMediaFacts({ format: {} })).toEqual({
    durationSec: null,
    streams: [],
    videoStreamCount: 0,
    chapterCount: 0,
  });
  expect(parseMediaFacts({ format: { duration: 'N/A' } }).durationSec).toBeNull();
});

test('parseMediaFacts - rejects foreign shapes', () => {
  expect(() => parseMediaFacts({ streams: 'nope' })).toThrow();
});
