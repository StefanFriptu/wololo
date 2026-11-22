import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ensureFixture,
  FIXTURES,
  type FixtureAudioCodec,
  type FixtureLayout,
  type FixtureSpec,
  ffmpegAvailable,
} from '../../../test/helpers/fixtures.ts';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import type { FfmpegProgress } from '../../contracts/rules-ffmpeg.ts';
import { runProcess } from '../../core/process.ts';
import type {
  ConversionPlan,
  DeviceProfileDefinition,
  EffectiveProfile,
  LibraryRuleSettings,
  MediaStream,
  ProbeResult,
} from '../../shared/domain.ts';
import { templateDefinition } from '../profiles/profileTemplates.ts';
import { planConversion, resolveEffectiveProfile } from '../rules/engine.ts';
import { buildAudioConversionArgs } from './args.ts';
import { createProgressParser } from './progress.ts';

const TIMEOUT_MS = 120_000;

const LIBRARY: LibraryRuleSettings = {
  mode: 'replace',
  keepLanguages: [],
  keepOriginalLanguage: true,
  keepUndetermined: true,
  fillMissingLanguage: 'off',
};

const FfprobeStreamSchema = z.object({
  index: z.number(),
  codec_name: z.string().optional(),
  codec_type: z.string(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  sample_rate: z.string().optional(),
  bit_rate: z.string().optional(),
  profile: z.string().optional(),
  disposition: z.record(z.string(), z.number()).default({}),
  tags: z.record(z.string(), z.string()).default({}),
});

const FfprobeOutputSchema = z.object({
  streams: z.array(FfprobeStreamSchema),
  chapters: z.array(z.unknown()).default([]),
  format: z.object({ duration: z.string(), size: z.string() }),
});

type FfprobeOutput = z.infer<typeof FfprobeOutputSchema>;
type FfprobeStream = z.infer<typeof FfprobeStreamSchema>;

const scratch = mkdtempSync(join(tmpdir(), 'wololo-ffmpeg-args-'));
let outputs = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function effective(definition: DeviceProfileDefinition): EffectiveProfile {
  return resolveEffectiveProfile([
    {
      id: 1,
      name: 'test',
      description: '',
      version: 1,
      definition,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

const TIZEN = effective(templateDefinition('basic'));

async function run(command: string, args: string[], onStdoutLine?: (line: string) => void) {
  const result = await runProcess({ command, args, lowPriority: false, timeoutMs: 60_000, onStdoutLine });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

async function ffprobe(path: string): Promise<FfprobeOutput> {
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of',
    'json',
    path,
  ]);
  return FfprobeOutputSchema.parse(JSON.parse(result.stdout));
}

function toStream(stream: FfprobeStream): MediaStream[] {
  const common = {
    codec: stream.codec_name ?? 'none',
    language: stream.tags.language ?? null,
    title: stream.tags.title ?? null,
    default: stream.disposition.default === 1,
    forced: stream.disposition.forced === 1,
    profile: stream.profile ?? null,
  };
  if (stream.codec_type === 'video') return [videoStream(common)];
  if (stream.codec_type === 'subtitle') return [subtitleStream(common)];
  if (stream.codec_type !== 'audio') return [];
  return [
    audioStream({
      ...common,
      channels: stream.channels ?? 0,
      channelLayout: stream.channel_layout ?? null,
      sampleRate: Number(stream.sample_rate ?? 0),
    }),
  ];
}

function toProbe(path: string, output: FfprobeOutput): ProbeResult {
  return probeResult(output.streams.flatMap(toStream), {
    path,
    durationSec: Number(output.format.duration),
    sizeBytes: Number(output.format.size),
    chapterCount: output.chapters.length,
  });
}

async function videoHash(path: string): Promise<string> {
  const result = await run('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-f',
    'streamhash',
    '-hash',
    'md5',
    '-',
  ]);
  return result.stdout.trim();
}

async function decodeErrors(path: string): Promise<string> {
  const result = await run('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-f', 'null', '-']);
  return result.stderr.trim();
}

interface Conversion {
  source: string;
  probe: ProbeResult;
  plan: ConversionPlan;
  args: string[];
  output: FfprobeOutput;
  outputPath: string;
  updates: FfmpegProgress[];
}

interface ConvertOptions {
  library?: Partial<LibraryRuleSettings>;
  profile?: EffectiveProfile;
  originalLanguage?: string | null;
  extension?: string;
  reducePlan?: (plan: ConversionPlan) => ConversionPlan;
}

async function convertFile(source: string, options: ConvertOptions = {}): Promise<Conversion> {
  const probe = toProbe(source, await ffprobe(source));
  const fullPlan = planConversion({
    probe,
    profile: options.profile ?? TIZEN,
    library: { ...LIBRARY, ...options.library },
    originalLanguage: options.originalLanguage ?? null,
  });
  const plan = options.reducePlan ? options.reducePlan(fullPlan) : fullPlan;
  outputs += 1;
  const outputPath = join(scratch, `out-${outputs}.wololo-tmp.${options.extension ?? 'mkv'}`);
  const args = buildAudioConversionArgs({ inputPath: source, outputPath, probe, plan });
  const parser = createProgressParser(probe.durationSec);
  const updates: FfmpegProgress[] = [];
  await run('ffmpeg', args, (line) => {
    const update = parser.push(line);
    if (update) updates.push(update);
  });
  return { source, probe, plan, args, output: await ffprobe(outputPath), outputPath, updates };
}

async function convert(spec: FixtureSpec, options: ConvertOptions = {}): Promise<Conversion> {
  return convertFile(await ensureFixture(spec), options);
}

function audioOf(output: FfprobeOutput): FfprobeStream[] {
  return output.streams.filter((stream) => stream.codec_type === 'audio');
}

async function expectSafeOutput(conversion: Conversion) {
  expect(Math.abs(Number(conversion.output.format.duration) - conversion.probe.durationSec)).toBeLessThanOrEqual(0.1);
  expect(conversion.output.streams).toHaveLength(conversion.plan.streams.length);
  expect(await videoHash(conversion.outputPath)).toBe(await videoHash(conversion.source));
  expect(await decodeErrors(conversion.outputPath)).toBe('');
  expect(conversion.updates.at(-1)).toMatchObject({ done: true, progress: 1 });
  for (const stream of audioOf(conversion.output)) expect(stream.sample_rate).toBe('48000');
}

function singleTrack(codec: FixtureAudioCodec, layout: FixtureLayout): FixtureSpec {
  return {
    name: `rules-ffmpeg-${codec}-${layout}`,
    audio: [{ codec, layout, language: 'eng', title: `${codec} ${layout}` }],
  };
}

describe.skipIf(!ffmpegAvailable())('buildAudioConversionArgs with real ffmpeg', () => {
  test.each([
    ['dts', '5.1', 6, '5.1(side)', '640000'],
    ['dts', 'stereo', 2, 'stereo', '448000'],
    ['dts', 'mono', 1, 'mono', '192000'],
    ['truehd', '5.1', 6, '5.1(side)', '640000'],
    ['truehd', 'stereo', 2, 'stereo', '448000'],
    ['truehd', 'mono', 1, 'mono', '192000'],
    ['eac3', '5.1', 6, '5.1(side)', '640000'],
    ['eac3', 'stereo', 2, 'stereo', '448000'],
    ['eac3', 'mono', 1, 'mono', '192000'],
    ['flac', '7.1', 6, '5.1(side)', '640000'],
    ['flac', '5.1', 6, '5.1(side)', '640000'],
    ['flac', '5.0', 5, '5.0(side)', '640000'],
    ['flac', 'stereo', 2, 'stereo', '448000'],
    ['flac', 'mono', 1, 'mono', '192000'],
    ['pcm_s24le', '7.1', 6, '5.1(side)', '640000'],
    ['pcm_s24le', 'stereo', 2, 'stereo', '448000'],
    ['opus', 'stereo', 2, 'stereo', '448000'],
  ] as const)(
    'buildAudioConversionArgs - %s %s converts to ac3 %i channels (%s) at %s bps',
    async (codec, layout, channels, channelLayout, bitRate) => {
      const conversion = await convert(singleTrack(codec, layout));
      expect(conversion.plan.action).toBe('convert');
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)).toEqual([
        expect.objectContaining({
          codec_name: 'ac3',
          channels,
          channel_layout: channelLayout,
          bit_rate: bitRate,
          disposition: expect.objectContaining({ default: 1 }),
          tags: expect.objectContaining({ language: 'eng', title: `${codec} ${layout}` }),
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - 7.1 downmix is recorded as a lost feature',
    async () => {
      const conversion = await convert(FIXTURES.flac71);
      expect(conversion.plan.lostFeatures).toEqual(['7.1 downmixed to 5.1', 'Lossless FLAC converted to AC3 640 kbps']);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - ac3 sources already compatible are copied bit for bit',
    async () => {
      const conversion = await convert(singleTrack('ac3', '5.1'));
      expect(conversion.plan.action).toBe('skip');
      await expectSafeOutput(conversion);
      expect(conversion.args.some((arg) => arg.startsWith('-c:a'))).toBe(false);
      expect(audioOf(conversion.output)[0]).toMatchObject({ codec_name: 'ac3', channels: 6 });
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - dts 5.1 keeps subtitles, chapters and the video bit-identical',
    async () => {
      const conversion = await convert(FIXTURES.dts51, { originalLanguage: 'English' });
      await expectSafeOutput(conversion);
      expect(conversion.output.chapters).toHaveLength(3);
      expect(conversion.output.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
        ['video', 'h264'],
        ['audio', 'ac3'],
        ['subtitle', 'subrip'],
      ]);
      expect(conversion.output.streams[2]?.tags.language).toBe('eng');
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - truehd plus ac3 in the same language is remuxed without encoding',
    async () => {
      const conversion = await convert(FIXTURES.truehd51PlusAc3);
      expect(conversion.plan.action).toBe('remux');
      expect(conversion.args.some((arg) => arg.startsWith('-c:a'))).toBe(false);
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)).toEqual([
        expect.objectContaining({
          codec_name: 'ac3',
          tags: expect.objectContaining({ title: 'AC3 5.1', language: 'eng' }),
          disposition: expect.objectContaining({ default: 1 }),
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - keep both demotes truehd behind the compatible ac3',
    async () => {
      const conversion = await convert(FIXTURES.truehd51PlusAc3, { library: { mode: 'keep_both' } });
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output).map((stream) => [stream.codec_name, stream.disposition.default])).toEqual([
        ['truehd', 0],
        ['ac3', 1],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - keep both writes the converted track first and default, the original after',
    async () => {
      const conversion = await convert(FIXTURES.multiLanguage, {
        library: { mode: 'keep_both', keepLanguages: ['eng'] },
        originalLanguage: 'Spanish',
      });
      await expectSafeOutput(conversion);
      expect(conversion.output.chapters).toHaveLength(4);
      expect(
        audioOf(conversion.output).map((stream) => [
          stream.codec_name,
          stream.tags.language,
          stream.tags.title,
          stream.disposition.default,
        ]),
      ).toEqual([
        ['ac3', 'spa', 'Castellano DTS', 1],
        ['dts', 'spa', 'Castellano DTS', 0],
        ['ac3', 'eng', 'English', 0],
      ]);
      const subtitles = conversion.output.streams.filter((stream) => stream.codec_type === 'subtitle');
      expect(subtitles.map((stream) => [stream.tags.language, stream.disposition.forced])).toEqual([
        ['eng', 0],
        ['spa', 1],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - keep both writes the default converted track ahead of other languages',
    async () => {
      const conversion = await convert(
        {
          name: 'rules-ffmpeg-keep-both-two-languages',
          audio: [
            { codec: 'dts', layout: '5.1', language: 'fre', title: 'Francais' },
            { codec: 'dts', layout: 'stereo', language: 'eng', title: 'English', default: false },
          ],
        },
        { library: { mode: 'keep_both' }, originalLanguage: 'English' },
      );
      await expectSafeOutput(conversion);
      expect(
        audioOf(conversion.output).map((stream) => [
          stream.codec_name,
          stream.tags.language,
          stream.channels,
          stream.disposition.default,
        ]),
      ).toEqual([
        ['ac3', 'eng', 2, 1],
        ['ac3', 'fre', 6, 0],
        ['dts', 'fre', 6, 0],
        ['dts', 'eng', 2, 0],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - source language tags are kept as written (fra stays fra, deu stays deu)',
    async () => {
      const conversion = await convert({
        name: 'rules-ffmpeg-terminology-language-codes',
        audio: [
          { codec: 'dts', layout: '5.1', language: 'fra', title: 'Francais' },
          { codec: 'ac3', layout: 'stereo', language: 'deu', title: 'Deutsch', default: false },
        ],
      });
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output).map((stream) => [stream.codec_name, stream.tags.language])).toEqual([
        ['ac3', 'fra'],
        ['ac3', 'deu'],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - untagged audio is tagged with the original language',
    async () => {
      const conversion = await convert(FIXTURES.untaggedLanguage, {
        library: { fillMissingLanguage: 'original' },
        originalLanguage: 'Spanish',
      });
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)[0]).toMatchObject({
        codec_name: 'ac3',
        channels: 2,
        tags: expect.objectContaining({ language: 'spa' }),
      });
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - aac target keeps 7.1 when the profile allows 8 channels',
    async () => {
      const base = templateDefinition('basic');
      const profile = effective({ ...base, audio: { ...base.audio, targetCodec: 'aac', maxChannels: 8 } });
      const conversion = await convert(FIXTURES.flac71, { profile });
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)[0]).toMatchObject({ codec_name: 'aac', channels: 8, channel_layout: '7.1' });
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - eac3 target converts dts to eac3',
    async () => {
      const base = templateDefinition('basic');
      const profile = effective({
        ...base,
        audio: { ...base.audio, allowedCodecs: ['ac3', 'eac3', 'aac'], targetCodec: 'eac3' },
      });
      const conversion = await convert(FIXTURES.dts51, { profile });
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)[0]).toMatchObject({ codec_name: 'eac3', channels: 6, bit_rate: '640000' });
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - ac3 decoded for an aac-only profile runs without dynamic range compression',
    async () => {
      const base = templateDefinition('basic');
      const profile = effective({ ...base, audio: { ...base.audio, allowedCodecs: ['aac'], targetCodec: 'aac' } });
      const conversion = await convert(singleTrack('ac3', 'stereo'), { profile });
      expect(conversion.args.slice(0, conversion.args.indexOf('-i'))).toContain('-drc_scale');
      await expectSafeOutput(conversion);
      expect(audioOf(conversion.output)[0]).toMatchObject({ codec_name: 'aac', channels: 2 });
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - an audio-only side file carries one track and no chapters',
    async () => {
      const conversion = await convert(FIXTURES.dts51, {
        extension: 'mka',
        reducePlan: (plan) => ({ ...plan, streams: plan.streams.filter((stream) => stream.kind === 'audio') }),
      });
      expect(conversion.output.streams.map((stream) => stream.codec_name)).toEqual(['ac3']);
      expect(conversion.output.chapters).toHaveLength(0);
      expect(await decodeErrors(conversion.outputPath)).toBe('');
    },
    TIMEOUT_MS,
  );

  test(
    'buildAudioConversionArgs - stale mkvmerge statistics tags are cleared on encoded tracks only',
    async () => {
      const source = join(scratch, 'with-statistics.mkv');
      await run('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        await ensureFixture(FIXTURES.dts51),
        '-map',
        '0',
        '-c',
        'copy',
        '-metadata:s:a:0',
        'BPS=4500000',
        '-metadata:s:a:0',
        'NUMBER_OF_BYTES-eng=123456',
        source,
      ]);
      const conversion = await convertFile(source, { library: { mode: 'keep_both' } });
      const [converted, original] = audioOf(conversion.output);
      expect(converted?.codec_name).toBe('ac3');
      expect(converted?.tags.BPS).toBeUndefined();
      expect(converted?.tags['NUMBER_OF_BYTES-eng']).toBeUndefined();
      expect(original).toMatchObject({ codec_name: 'dts', tags: expect.objectContaining({ BPS: '4500000' }) });
    },
    TIMEOUT_MS,
  );
});
