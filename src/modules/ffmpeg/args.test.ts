import { expect, test } from 'bun:test';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import type { AudioConversionInput } from '../../contracts/rules-ffmpeg.ts';
import type { LibraryRuleSettings, MediaStream, ProbeResult } from '../../shared/domain.ts';
import { templateDefinition } from '../profiles/profileTemplates.ts';
import { planConversion, resolveEffectiveProfile } from '../rules/engine.ts';
import { buildAudioConversionArgs } from './args.ts';

const LIBRARY: LibraryRuleSettings = {
  mode: 'replace',
  keepLanguages: [],
  keepOriginalLanguage: true,
  keepUndetermined: true,
  fillMissingLanguage: 'off',
};

const TIZEN = resolveEffectiveProfile([
  {
    id: 1,
    name: 'Samsung Tizen',
    description: '',
    version: 1,
    definition: templateDefinition('basic'),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]);

const IN = '/data/media/movies/Movie (2020)/Movie (2020).mkv';
const OUT = '/data/media/movies/Movie (2020)/Movie (2020).wololo-tmp.mkv';

function input(
  streams: MediaStream[],
  options: { library?: Partial<LibraryRuleSettings>; outputPath?: string; probe?: Partial<ProbeResult> } = {},
): AudioConversionInput {
  const probe = probeResult(streams, options.probe);
  const plan = planConversion({
    probe,
    profile: TIZEN,
    library: { ...LIBRARY, ...options.library },
    originalLanguage: null,
  });
  return { inputPath: IN, outputPath: options.outputPath ?? OUT, probe, plan };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function clearedTags(specifier: string): string[] {
  return [
    'BPS',
    'DURATION',
    'NUMBER_OF_FRAMES',
    'NUMBER_OF_BYTES',
    '_STATISTICS_WRITING_APP',
    '_STATISTICS_WRITING_DATE_UTC',
    '_STATISTICS_TAGS',
  ].flatMap((tag) => [`-metadata:s:${specifier}`, `${tag}=`, `-metadata:s:${specifier}`, `${tag}-eng=`]);
}

test('buildAudioConversionArgs - dts 5.1 movie becomes the full ac3 conversion argv', () => {
  const args = buildAudioConversionArgs(
    input([
      videoStream(),
      audioStream({ codec: 'dts', profile: 'DTS-HD MA', language: 'eng', title: 'DTS-HD MA 5.1' }),
      subtitleStream({ language: 'eng' }),
    ]),
  );
  expect(args).toEqual([
    '-hide_banner',
    '-nostdin',
    '-y',
    '-core_only',
    '0',
    '-i',
    IN,
    '-map',
    '0:0',
    '-map',
    '0:1',
    '-map',
    '0:2',
    '-c',
    'copy',
    '-c:a:0',
    'ac3',
    '-b:a:0',
    '640k',
    '-ac:a:0',
    '6',
    ...clearedTags('a:0'),
    '-disposition:a:0',
    '+default',
    '-map_chapters',
    '0',
    '-map_metadata',
    '0',
    '-max_muxing_queue_size',
    '4096',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'matroska',
    OUT,
  ]);
});

test.each([
  ['dts', ['-core_only', '0']],
  ['truehd', []],
  ['eac3', ['-drc_scale', '0']],
  ['flac', []],
  ['pcm_s24le', []],
])('buildAudioConversionArgs - decoding %s adds decoder options %j', (codec, options) => {
  const args = buildAudioConversionArgs(input([audioStream({ codec })]));
  expect(args.slice(3, args.indexOf('-i'))).toEqual(options);
});

test('buildAudioConversionArgs - copied ac3 and eac3 tracks get no decoder options', () => {
  const args = buildAudioConversionArgs(
    input([audioStream({ codec: 'truehd' }), audioStream({ codec: 'ac3', channels: 2, default: false })]),
  );
  expect(args).not.toContain('-drc_scale');
  expect(args).not.toContain('-core_only');
});

test.each([
  ['dts 7.1', [audioStream({ codec: 'flac', channels: 8 })]],
  ['truehd + ac3', [audioStream({ codec: 'truehd' }), audioStream({ codec: 'ac3', default: false })]],
  ['pcm 96 kHz', [audioStream({ codec: 'pcm_s24le', channels: 2, sampleRate: 96000 })]],
  ['eac3 stereo', [audioStream({ codec: 'eac3', channels: 2 })]],
  ['mono flac', [audioStream({ codec: 'flac', channels: 1 })]],
])('buildAudioConversionArgs - %s never resamples, normalises or compresses', (_name, streams) => {
  const args = buildAudioConversionArgs(input([videoStream(), ...streams]));
  const forbidden = ['-ar', '-af', '-filter:a', '-filter_complex', '-dialnorm'];
  for (const flag of forbidden) expect(args.some((arg) => arg === flag || arg.startsWith(`${flag}:`))).toBe(false);
  expect(args.some((arg) => /loudnorm|dynaudnorm|acompressor|aresample/.test(arg))).toBe(false);
});

test('buildAudioConversionArgs - 7.1 source is downmixed with -ac 6 only', () => {
  const args = buildAudioConversionArgs(input([audioStream({ codec: 'flac', channels: 8 })]));
  expect(valueAfter(args, '-ac:a:0')).toBe('6');
  expect(valueAfter(args, '-b:a:0')).toBe('640k');
});

test.each([
  [2, '448k', '2'],
  [1, '192k', '1'],
])('buildAudioConversionArgs - %i channel source keeps its layout at %s', (channels, kbps, ac) => {
  const args = buildAudioConversionArgs(input([audioStream({ codec: 'eac3', channels })]));
  expect(valueAfter(args, '-b:a:0')).toBe(kbps);
  expect(valueAfter(args, '-ac:a:0')).toBe(ac);
});

test('buildAudioConversionArgs - keep both maps the source twice and encodes only the first copy', () => {
  const args = buildAudioConversionArgs(
    input([videoStream(), audioStream({ codec: 'dts', title: 'DTS' })], { library: { mode: 'keep_both' } }),
  );
  expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:0', '0:1', '0:1']);
  expect(valueAfter(args, '-c:a:0')).toBe('ac3');
  expect(args).not.toContain('-c:a:1');
  expect(valueAfter(args, '-disposition:a:0')).toBe('+default');
  expect(valueAfter(args, '-disposition:a:1')).toBe('-default');
});

test('buildAudioConversionArgs - dropped streams are not mapped and indexes count per stream type', () => {
  const args = buildAudioConversionArgs(
    input([
      videoStream(),
      audioStream({ codec: 'truehd', language: 'eng' }),
      audioStream({ codec: 'ac3', language: 'eng', default: false }),
      audioStream({ codec: 'dts', language: 'spa', channels: 2, default: false }),
      subtitleStream({ language: 'eng' }),
    ]),
  );
  expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:0', '0:2', '0:3', '0:4']);
  expect(valueAfter(args, '-c:a:1')).toBe('ac3');
  expect(valueAfter(args, '-b:a:1')).toBe('448k');
  expect(args).not.toContain('-c:a:0');
  expect(valueAfter(args, '-metadata:s:a:1')).toBe('BPS=');
  expect(args.filter((_, i) => args[i - 1] === '-disposition:a:0')).toEqual(['+default']);
});

test('buildAudioConversionArgs - retagged streams get their filled language', () => {
  const args = buildAudioConversionArgs(
    input([audioStream({ codec: 'ac3', language: null }), subtitleStream({ language: null })], {
      library: { fillMissingLanguage: 'spa' },
    }),
  );
  expect(valueAfter(args, '-metadata:s:a:0')).toBe('language=spa');
  expect(valueAfter(args, '-metadata:s:s:0')).toBe('language=spa');
});

test('buildAudioConversionArgs - tagged streams keep the source tag: no language metadata is written', () => {
  const args = buildAudioConversionArgs(
    input([audioStream({ codec: 'dts', language: 'fra' }), subtitleStream({ language: 'fra' })]),
  );
  expect(valueAfter(args, '-c:a:0')).toBe('ac3');
  expect(args.some((arg) => arg.startsWith('language='))).toBe(false);
});

test('buildAudioConversionArgs - tagAllLanguages writes every planned language (disc playlist languages)', () => {
  const base = input([audioStream({ codec: 'ac3', language: 'fre' }), subtitleStream({ language: 'spa' })]);
  const args = buildAudioConversionArgs({ ...base, tagAllLanguages: true });
  expect(valueAfter(args, '-metadata:s:a:0')).toBe('language=fre');
  expect(valueAfter(args, '-metadata:s:s:0')).toBe('language=spa');
});

test('buildAudioConversionArgs - untagged streams get no language metadata', () => {
  const args = buildAudioConversionArgs(input([audioStream({ codec: 'dts', language: null })]));
  expect(args.some((arg) => arg.startsWith('language='))).toBe(false);
});

test('buildAudioConversionArgs - input options go before -i for bluray playlists', () => {
  const base = input([videoStream(), audioStream({ codec: 'dts' })]);
  const args = buildAudioConversionArgs({
    ...base,
    inputPath: 'bluray:/data/downloads/Movie',
    inputOptions: ['-playlist', '800'],
    outputPath: '/data/media/.wololo-tmp-7/audio-1.mka',
  });
  expect(args.slice(3, 9)).toEqual(['-core_only', '0', '-playlist', '800', '-i', 'bluray:/data/downloads/Movie']);
  expect(valueAfter(args, '-map_chapters')).toBe('-1');
  expect(valueAfter(args, '-f')).toBe('matroska');
});

test('buildAudioConversionArgs - mov_text subtitles become srt in matroska', () => {
  const args = buildAudioConversionArgs(
    input([videoStream(), audioStream({ codec: 'aac', channels: 2 }), subtitleStream({ codec: 'mov_text' })]),
  );
  expect(valueAfter(args, '-c:s:0')).toBe('srt');
});

test('buildAudioConversionArgs - mp4 output keeps mp4 and turns text subtitles into mov_text', () => {
  const args = buildAudioConversionArgs(
    input([videoStream(), audioStream({ codec: 'eac3' }), subtitleStream({ codec: 'subrip' })], {
      outputPath: '/data/media/Movie.wololo-tmp.mp4',
    }),
  );
  expect(valueAfter(args, '-f')).toBe('mp4');
  expect(valueAfter(args, '-c:s:0')).toBe('mov_text');
});

test.each([
  ['missing', [] as MediaStream[]],
  ['of another kind', [videoStream()]],
])('buildAudioConversionArgs - a plan stream %s in the probe is an error', (_name, streams) => {
  const base = input([audioStream({ codec: 'dts' })]);
  expect(() => buildAudioConversionArgs({ ...base, probe: probeResult(streams) })).toThrow(
    'planned audio stream 0 is not in the probe',
  );
});

test('buildAudioConversionArgs - output path is the last argument', () => {
  const args = buildAudioConversionArgs(input([audioStream({ codec: 'flac' })]));
  expect(args.at(-1)).toBe(OUT);
  expect(args.at(-2)).toBe('matroska');
});

test.each([
  ['the input path', IN],
  ['the input path written differently', '/data/media/movies/./Movie (2020)/Movie (2020).mkv'],
])('buildAudioConversionArgs - output path equal to %s is an error', (_name, outputPath) => {
  expect(() => buildAudioConversionArgs(input([audioStream({ codec: 'dts' })], { outputPath }))).toThrow(
    'is the input file',
  );
});

test('buildAudioConversionArgs - output path starting with a dash is an error', () => {
  expect(() =>
    buildAudioConversionArgs(input([audioStream({ codec: 'dts' })], { outputPath: '-movie.wololo-tmp.mkv' })),
  ).toThrow('would be read as an ffmpeg option');
});
