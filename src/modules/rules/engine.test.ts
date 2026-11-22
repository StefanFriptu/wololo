import { expect, test } from 'bun:test';
import { audioStream, probeResult, subtitleStream, videoStream } from '../../../test/helpers/probe.ts';
import type {
  AudioStream,
  ConversionPlan,
  DeviceProfile,
  DeviceProfileDefinition,
  EffectiveProfile,
  LibraryRuleSettings,
  MediaStream,
  OtherStream,
  PlannedStream,
} from '../../shared/domain.ts';
import { templateDefinition } from '../profiles/profileTemplates.ts';
import { checkProfiles, codecAllowed, computeRulesKey, planConversion, resolveEffectiveProfile } from './engine.ts';

const LIBRARY: LibraryRuleSettings = {
  mode: 'replace',
  keepLanguages: [],
  keepOriginalLanguage: true,
  keepUndetermined: true,
  fillMissingLanguage: 'off',
};

function deviceProfile(id: number, definition: DeviceProfileDefinition, version = 1): DeviceProfile {
  return {
    id,
    name: `profile ${id}`,
    description: '',
    version,
    definition,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function withAudio(audio: Partial<DeviceProfileDefinition['audio']>): DeviceProfileDefinition {
  const base = templateDefinition('basic');
  return { ...base, audio: { ...base.audio, ...audio } };
}

const TIZEN = resolveEffectiveProfile([deviceProfile(1, templateDefinition('basic'))]);

interface PlanOptions {
  library?: Partial<LibraryRuleSettings>;
  profile?: EffectiveProfile;
  originalLanguage?: string | null;
  durationSec?: number;
  sizeBytes?: number;
}

function plan(streams: MediaStream[], options: PlanOptions = {}): ConversionPlan {
  return planConversion({
    probe: probeResult(streams, {
      durationSec: options.durationSec ?? 5400,
      sizeBytes: options.sizeBytes ?? 8_000_000_000,
    }),
    profile: options.profile ?? TIZEN,
    library: { ...LIBRARY, ...options.library },
    originalLanguage: options.originalLanguage ?? null,
  });
}

function audioOut(result: ConversionPlan): PlannedStream[] {
  return result.streams.filter((stream) => stream.kind === 'audio');
}

function onlyEncode(result: ConversionPlan) {
  const encoded = result.streams.filter((stream) => stream.op === 'encode');
  expect(encoded).toHaveLength(1);
  return encoded[0]?.encode;
}

function dataStream(): OtherStream {
  return {
    index: 0,
    streamId: null,
    startTimeSec: 0,
    kind: 'data',
    codec: 'bin_data',
    codecLongName: null,
    profile: null,
    language: null,
    title: null,
    default: false,
    forced: false,
    bitRate: null,
    durationSec: null,
    filename: null,
    mimeType: null,
  };
}

test.each([
  ['ac3', ['ac3', 'aac'], true],
  ['AC3', ['ac3'], true],
  ['ac3', ['AC3'], true],
  ['dts', ['ac3', 'aac', 'mp3'], false],
  ['eac3', ['ac3'], false],
  ['pcm_s24le', ['pcm_*'], true],
  ['pcm_bluray', ['ac3', 'pcm_*'], true],
  ['flac', ['pcm_*'], false],
  ['ac3', [], false],
  ['vorbis', ['*'], true],
] as const)('codecAllowed - %s against %j is %p', (codec, allowed, expected) => {
  expect(codecAllowed(codec, allowed)).toBe(expected);
});

test.each([
  ['dts', null, null],
  ['dts', 'DTS-HD MA', null],
  ['dts', 'DTS-HD MA', 'dtsx' as const],
  ['truehd', null, null],
  ['truehd', 'Dolby TrueHD + Dolby Atmos', 'atmos' as const],
  ['eac3', null, null],
  ['eac3', 'Dolby Digital Plus + Dolby Atmos', 'atmos' as const],
  ['pcm_s16le', null, null],
  ['pcm_s24le', null, null],
  ['pcm_bluray', null, null],
  ['flac', null, null],
  ['opus', null, null],
  ['vorbis', null, null],
])('planConversion - tizen converts %s (%s, object audio %s) to ac3', (codec, profile, objectAudio) => {
  const result = plan([videoStream(), audioStream({ codec, profile, objectAudio })]);
  expect(result.action).toBe('convert');
  expect(result.failingCodecs).toEqual([codec]);
  expect(onlyEncode(result)).toMatchObject({ codec: 'ac3', bitrateKbps: 640, channels: 6 });
});

test.each(['ac3', 'aac', 'mp3'])('planConversion - tizen copies %s untouched', (codec) => {
  const result = plan([videoStream(), audioStream({ codec, channels: 6 }), subtitleStream()]);
  expect(result.action).toBe('skip');
  expect(result.streams.map((stream) => stream.op)).toEqual(['copy', 'copy', 'copy']);
  expect(result.failingCodecs).toEqual([]);
  expect(result.reasons).toEqual([]);
  expect(result.estimatedOutputBytes).toBeNull();
});

test.each([
  ['flac', ['ac3', 'aac', 'mp3', 'flac']],
  ['opus', ['ac3', 'aac', 'mp3', 'opus', 'vorbis']],
  ['vorbis', ['ac3', 'aac', 'mp3', 'opus', 'vorbis']],
  ['eac3', ['ac3', 'aac', 'mp3', 'eac3']],
  ['pcm_s24le', ['ac3', 'pcm_*']],
])('planConversion - %s is copied when the profile toggles it on', (codec, allowedCodecs) => {
  const profile = resolveEffectiveProfile([deviceProfile(2, withAudio({ allowedCodecs }))]);
  expect(plan([videoStream(), audioStream({ codec })], { profile }).action).toBe('skip');
});

test.each([
  [8, '7.1', 6, '5.1', 640, true],
  [8, '7.1(wide)', 6, '5.1', 640, true],
  [7, '6.1', 6, '5.1', 640, true],
  [6, '5.1(side)', 6, '5.1(side)', 640, false],
  [6, '5.1', 6, '5.1', 640, false],
  [5, '5.0', 5, '5.0', 640, false],
  [2, 'stereo', 2, 'stereo', 448, false],
  [1, 'mono', 1, 'mono', 192, false],
  [6, null, 6, '5.1', 640, false],
])(
  'planConversion - %i channel %s source becomes ac3 %i channels (%s) at %i kbps',
  (channels, layout, outChannels, outLayout, kbps, downmixed) => {
    const result = plan([audioStream({ codec: 'flac', channels, channelLayout: layout })]);
    expect(onlyEncode(result)).toEqual({
      codec: 'ac3',
      bitrateKbps: kbps,
      channels: outChannels,
      channelLayout: outLayout,
      downmixed,
    });
  },
);

test.each([
  ['eac3' as const, 8, 6, 640],
  ['aac' as const, 8, 8, 640],
  ['aac' as const, 2, 2, 448],
])(
  'planConversion - target %s for %i channels gives %i channels at %i kbps',
  (targetCodec, channels, outChannels, kbps) => {
    const profile = resolveEffectiveProfile([
      deviceProfile(2, withAudio({ allowedCodecs: ['ac3', 'eac3', 'aac'], targetCodec, maxChannels: 8 })),
    ]);
    const result = plan([audioStream({ codec: 'truehd', channels })], { profile });
    expect(onlyEncode(result)).toMatchObject({ codec: targetCodec, channels: outChannels, bitrateKbps: kbps });
  },
);

test('planConversion - maxChannels 2 downmixes 5.1 to stereo at the stereo bitrate', () => {
  const profile = resolveEffectiveProfile([deviceProfile(2, withAudio({ maxChannels: 2 }))]);
  const result = plan([audioStream({ codec: 'dts', channels: 6 })], { profile });
  expect(onlyEncode(result)).toEqual({
    codec: 'ac3',
    bitrateKbps: 448,
    channels: 2,
    channelLayout: 'stereo',
    downmixed: true,
  });
  expect(result.lostFeatures).toContain('5.1 downmixed to 2.0');
});

test('planConversion - 5.1 DTS-HD MA ends up as one ac3 5.1 640 kbps track replacing the original', () => {
  const result = plan(
    [
      videoStream(),
      audioStream({ codec: 'dts', profile: 'DTS-HD MA', title: 'DTS-HD MA 5.1', language: 'eng' }),
      subtitleStream(),
    ],
    { originalLanguage: 'English' },
  );
  expect(result.action).toBe('convert');
  expect(result.streams).toEqual([
    expect.objectContaining({ sourceIndex: 0, kind: 'video', op: 'copy' }),
    {
      sourceIndex: 1,
      kind: 'audio',
      op: 'encode',
      codec: 'ac3',
      encode: { codec: 'ac3', bitrateKbps: 640, channels: 6, channelLayout: '5.1(side)', downmixed: false },
      language: 'eng',
      retagged: false,
      title: 'DTS-HD MA 5.1',
      default: true,
      forced: false,
    },
    expect.objectContaining({ sourceIndex: 2, kind: 'subtitle', op: 'copy' }),
  ]);
  expect(result.dropped).toEqual([
    { sourceIndex: 1, kind: 'audio', codec: 'dts', language: 'eng', reason: 'incompatible_replaced' },
  ]);
  expect(result.lostFeatures).toEqual(['Lossless DTS-HD MA converted to AC3 640 kbps']);
  expect(result.reasons).toEqual(['dts (eng, 5.1) not decoded by profile, converted to ac3 5.1 640 kbps']);
});

test('planConversion - truehd atmos 7.1 records the dropped height channels and the downmix', () => {
  const result = plan([
    audioStream({ codec: 'truehd', channels: 8, profile: 'Dolby TrueHD + Dolby Atmos', objectAudio: 'atmos' }),
  ]);
  expect(result.lostFeatures).toEqual([
    'Atmos height channels dropped',
    '7.1 downmixed to 5.1',
    'Lossless TrueHD converted to AC3 640 kbps',
  ]);
});

test('planConversion - dts:x records its dropped height channels', () => {
  const result = plan([audioStream({ codec: 'dts', profile: 'DTS:X', objectAudio: 'dtsx', lossless: true })]);
  expect(result.lostFeatures).toContain('DTS:X height channels dropped');
});

test('planConversion - lossy dts core-only source records no lossless loss', () => {
  const result = plan([audioStream({ codec: 'dts', profile: 'DTS', lossless: false })]);
  expect(result.lostFeatures).toEqual([]);
});

test('planConversion - 96 kHz source records the resample forced by ac3', () => {
  const result = plan([audioStream({ codec: 'pcm_s24le', channels: 2, sampleRate: 96000 })]);
  expect(result.lostFeatures).toContain('96 kHz resampled to 48 kHz');
});

test.each([
  [22050, '22.05 kHz resampled to 32 kHz'],
  [11025, '11.025 kHz resampled to 32 kHz'],
  [88200, '88.2 kHz resampled to 48 kHz'],
])('planConversion - %d Hz source records the resample forced by ac3', (sampleRate, loss) => {
  const result = plan([audioStream({ codec: 'flac', channels: 2, sampleRate })]);
  expect(result.lostFeatures).toContain(loss);
});

test('planConversion - 44.1 kHz source records no resample because ac3 accepts it', () => {
  const result = plan([audioStream({ codec: 'flac', channels: 2, sampleRate: 44100 })]);
  expect(result.lostFeatures.some((feature) => feature.includes('kHz'))).toBe(false);
});

test('planConversion - 48 kHz source records no resample', () => {
  const result = plan([audioStream({ codec: 'flac', channels: 2, sampleRate: 48000 })]);
  expect(result.lostFeatures.some((feature) => feature.includes('kHz'))).toBe(false);
});

test('planConversion - truehd plus ac3 in the same language is remuxed without encoding', () => {
  const result = plan([
    videoStream(),
    audioStream({ codec: 'truehd', channels: 6, title: 'TrueHD 5.1' }),
    audioStream({ codec: 'ac3', channels: 6, title: 'AC3 5.1', default: false }),
  ]);
  expect(result.action).toBe('remux');
  expect(result.streams.some((stream) => stream.op === 'encode')).toBe(false);
  expect(audioOut(result)).toEqual([expect.objectContaining({ sourceIndex: 2, codec: 'ac3', default: true })]);
  expect(result.dropped).toEqual([
    { sourceIndex: 1, kind: 'audio', codec: 'truehd', language: 'eng', reason: 'compatible_duplicate' },
  ]);
  expect(result.failingCodecs).toEqual(['truehd']);
  expect(result.lostFeatures).toEqual(['Lossless TrueHD dropped for ac3']);
});

test('planConversion - truehd 7.1 plus ac3 5.1 skips the encode because ac3 caps at 5.1', () => {
  const result = plan([
    audioStream({ codec: 'truehd', channels: 8, objectAudio: 'atmos' }),
    audioStream({ codec: 'ac3', channels: 6, default: false }),
  ]);
  expect(result.action).toBe('remux');
  expect(result.lostFeatures).toEqual([
    'Atmos height channels dropped',
    '7.1 downmixed to 5.1',
    'Lossless TrueHD dropped for ac3',
  ]);
});

test('planConversion - compatible track with fewer channels does not stop the conversion', () => {
  const result = plan([
    audioStream({ codec: 'truehd', channels: 6 }),
    audioStream({ codec: 'ac3', channels: 2, default: false }),
  ]);
  expect(result.action).toBe('convert');
  expect(audioOut(result).map((stream) => [stream.codec, stream.op])).toEqual([
    ['ac3', 'encode'],
    ['ac3', 'copy'],
  ]);
});

test('planConversion - compatible track in another language does not stop the conversion', () => {
  const result = plan([
    audioStream({ codec: 'truehd', language: 'eng' }),
    audioStream({ codec: 'ac3', language: 'ger', default: false }),
  ]);
  expect(result.action).toBe('convert');
});

test('planConversion - language aliases count as the same language for the compatible-track skip', () => {
  const result = plan([
    audioStream({ codec: 'truehd', language: 'deu' }),
    audioStream({ codec: 'ac3', language: 'ger', default: false }),
  ]);
  expect(result.action).toBe('remux');
  expect(result.dropped[0]?.reason).toBe('compatible_duplicate');
});

test.each([
  ['untagged', null, 'untagged', null, 'off', 'convert'],
  ['untagged', null, 'tagged', 'eng', 'off', 'convert'],
  ['tagged', 'eng', 'untagged', null, 'off', 'convert'],
  ['untagged', null, 'untagged', null, 'original', 'remux'],
  ['untagged', null, 'untagged', null, 'eng', 'remux'],
] as const)(
  'planConversion - %s dts plus %s ac3 with fill %s plans %s',
  (_dtsName, dtsLanguage, _ac3Name, ac3Language, fill, action) => {
    const result = plan(
      [
        videoStream(),
        audioStream({ codec: 'dts', language: dtsLanguage, default: true }),
        audioStream({ codec: 'ac3', language: ac3Language, default: false }),
      ],
      { library: { fillMissingLanguage: fill }, originalLanguage: 'eng' },
    );
    expect(result.action).toBe(action);
    const kept = action === 'convert' ? [1, 2] : [2];
    expect(audioOut(result).map((stream) => stream.sourceIndex)).toEqual(kept);
  },
);

test.each([
  ['dts', 'English DTS-HD MA 1.0', 1, 'ac3', 'Commentary by Director', 2, [true, false]],
  ['truehd', 'Main', 2, 'ac3', 'Audio Description', 2, [true, false]],
  ['dts', null, 6, 'ac3', 'Descriptive Video Service', 6, [true, false]],
  ['flac', null, 2, 'aac', 'Isolated Score', 2, [true, false]],
  ['dts', 'Director commentary', 6, 'ac3', null, 6, [false, true]],
] as const)(
  'planConversion - %s %j with %p channels is kept beside a compatible %s %j with %p channels',
  (codec, title, channels, compatibleCodec, compatibleTitle, compatibleChannels, defaults) => {
    const result = plan([
      videoStream(),
      audioStream({ codec, title, channels, profile: codec === 'dts' ? 'DTS-HD MA' : null, default: true }),
      audioStream({ codec: compatibleCodec, title: compatibleTitle, channels: compatibleChannels, default: false }),
    ]);
    expect(result.action).toBe('convert');
    expect(result.dropped.map((drop) => drop.reason)).toEqual(['incompatible_replaced']);
    expect(audioOut(result).map((stream) => [stream.sourceIndex, stream.op])).toEqual([
      [1, 'encode'],
      [2, 'copy'],
    ]);
    expect(audioOut(result).map((stream) => stream.default)).toEqual([...defaults]);
  },
);

test.each([
  [5400, 5400, 'remux'],
  [5400, 5450, 'remux'],
  [5400, 1200, 'convert'],
  [null, 1200, 'remux'],
] as const)('planConversion - durations %p and %p of the same-language pair plan %s', (main, other, action) => {
  const result = plan([
    audioStream({ codec: 'truehd', durationSec: main }),
    audioStream({ codec: 'ac3', durationSec: other, default: false }),
  ]);
  expect(result.action).toBe(action);
});

test('planConversion - a commentary never becomes default when the source default is filtered out', () => {
  const result = plan(
    [
      videoStream(),
      audioStream({ codec: 'ac3', language: 'fre', default: true }),
      audioStream({ codec: 'ac3', language: 'eng', title: 'Commentary', default: false }),
      audioStream({ codec: 'ac3', language: 'eng', title: 'English', default: false }),
    ],
    { library: { keepLanguages: ['eng'], keepOriginalLanguage: false } },
  );
  expect(audioOut(result).map((stream) => [stream.sourceIndex, stream.default])).toEqual([
    [2, false],
    [3, true],
  ]);
});

test('planConversion - a commentary stays default when it is the only playable audio', () => {
  const result = plan([audioStream({ codec: 'ac3', title: 'Commentary', default: true })]);
  expect(result.action).toBe('skip');
  expect(audioOut(result)[0]?.default).toBe(true);
});

test('planConversion - keep both demotes the incompatible track behind a compatible same-language track', () => {
  const result = plan(
    [audioStream({ codec: 'truehd', default: true }), audioStream({ codec: 'ac3', default: false })],
    { library: { mode: 'keep_both' } },
  );
  expect(result.action).toBe('remux');
  expect(result.dropped).toEqual([]);
  expect(audioOut(result).map((stream) => [stream.codec, stream.default])).toEqual([
    ['truehd', false],
    ['ac3', true],
  ]);
});

test('planConversion - keep both with the compatible track already default is skipped', () => {
  const result = plan(
    [audioStream({ codec: 'truehd', default: false }), audioStream({ codec: 'ac3', default: true })],
    { library: { mode: 'keep_both' } },
  );
  expect(result.action).toBe('skip');
});

test('planConversion - keep both puts the converted track first, marks it default and keeps the original after', () => {
  const result = plan([videoStream(), audioStream({ codec: 'dts', title: 'DTS' })], {
    library: { mode: 'keep_both' },
  });
  expect(result.action).toBe('convert');
  expect(audioOut(result)).toEqual([
    expect.objectContaining({ sourceIndex: 1, op: 'encode', codec: 'ac3', default: true, title: 'DTS' }),
    expect.objectContaining({ sourceIndex: 1, op: 'copy', codec: 'dts', default: false, title: 'DTS' }),
  ]);
  expect(result.dropped).toEqual([]);
  expect(result.lostFeatures).toEqual([]);
});

function applyPlan(source: readonly MediaStream[], result: ConversionPlan): MediaStream[] {
  return result.streams.map((planned, index): MediaStream => {
    const from = source.find((stream) => stream.index === planned.sourceIndex) as MediaStream;
    const common = { index, language: planned.language, title: planned.title, default: planned.default };
    if (from.kind !== 'audio' || planned.encode === null) return { ...from, ...common };
    const { codec, channels, channelLayout } = planned.encode;
    return { ...from, ...common, codec, channels, channelLayout, lossless: false, profile: null };
  });
}

test.each([
  ['tagged', 'eng'],
  ['untagged', null],
] as const)('planConversion - keep both re-plans a converted %s file as skip', (_name, language) => {
  const source = [videoStream(), audioStream({ index: 1, codec: 'dts', language })];
  const first = plan(source, { library: { mode: 'keep_both' } });
  expect(first.action).toBe('convert');

  const converted = applyPlan(source, first);
  expect(converted.map((stream) => stream.codec)).toEqual(['h264', 'ac3', 'dts']);
  expect(plan(converted, { library: { mode: 'keep_both' } }).action).toBe('skip');
});

test('planConversion - replace never pairs an untagged compatible track with an untagged incompatible one', () => {
  const result = plan([
    videoStream(),
    audioStream({ codec: 'ac3', language: null, default: true }),
    audioStream({ codec: 'dts', language: null, default: false }),
  ]);
  expect(result.action).toBe('convert');
  expect(result.dropped.map((drop) => drop.reason)).toEqual(['incompatible_replaced']);
});

test('planConversion - keep both pairs every converted track with its original', () => {
  const result = plan(
    [
      audioStream({ codec: 'dts', language: 'eng' }),
      audioStream({ codec: 'eac3', language: 'spa', channels: 2, default: false }),
    ],
    { library: { mode: 'keep_both' }, originalLanguage: 'eng' },
  );
  expect(audioOut(result).map((stream) => [stream.sourceIndex, stream.codec, stream.default])).toEqual([
    [0, 'ac3', true],
    [0, 'dts', false],
    [1, 'ac3', false],
    [1, 'eac3', false],
  ]);
});

test('planConversion - keep both moves the default converted track ahead of other languages', () => {
  const result = plan(
    [
      videoStream(),
      audioStream({ codec: 'dts', language: 'fre', default: true }),
      audioStream({ codec: 'dts', language: 'eng', default: false }),
      subtitleStream(),
    ],
    { library: { mode: 'keep_both' }, originalLanguage: 'eng' },
  );
  expect(result.streams.map((stream) => [stream.sourceIndex, stream.codec])).toEqual([
    [0, 'h264'],
    [2, 'ac3'],
    [1, 'ac3'],
    [1, 'dts'],
    [2, 'dts'],
    [3, 'subrip'],
  ]);
  expect(audioOut(result).map((stream) => stream.default)).toEqual([true, false, false, false]);
});

test('planConversion - replace keeps the converted track in the original position', () => {
  const result = plan([
    videoStream(),
    audioStream({ codec: 'ac3', language: 'spa', default: false }),
    audioStream({ codec: 'dts', language: 'eng', default: true }),
    subtitleStream(),
  ]);
  expect(result.streams.map((stream) => [stream.sourceIndex, stream.codec])).toEqual([
    [0, 'h264'],
    [1, 'ac3'],
    [2, 'ac3'],
    [3, 'subrip'],
  ]);
});

test('planConversion - language filter keeps listed languages plus the original language', () => {
  const result = plan(
    [
      videoStream(),
      audioStream({ codec: 'ac3', language: 'spa' }),
      audioStream({ codec: 'ac3', language: 'eng', default: false }),
      audioStream({ codec: 'ac3', language: 'ger', default: false }),
      subtitleStream({ language: 'eng' }),
      subtitleStream({ language: 'fre' }),
      subtitleStream({ language: 'spa', forced: true }),
    ],
    { library: { keepLanguages: ['eng'] }, originalLanguage: 'Spanish' },
  );
  expect(result.action).toBe('remux');
  expect(result.streams.map((stream) => [stream.kind, stream.language])).toEqual([
    ['video', null],
    ['audio', 'spa'],
    ['audio', 'eng'],
    ['subtitle', 'eng'],
    ['subtitle', 'spa'],
  ]);
  expect(result.dropped.map((drop) => [drop.kind, drop.language, drop.reason])).toEqual([
    ['audio', 'ger', 'language_filter'],
    ['subtitle', 'fre', 'language_filter'],
  ]);
  expect(result.failingCodecs).toEqual([]);
});

test('planConversion - language filter drops the original language when keepOriginalLanguage is off', () => {
  const result = plan(
    [audioStream({ codec: 'ac3', language: 'spa' }), audioStream({ codec: 'ac3', language: 'eng', default: false })],
    { library: { keepLanguages: ['eng'], keepOriginalLanguage: false }, originalLanguage: 'spa' },
  );
  expect(audioOut(result).map((stream) => stream.language)).toEqual(['eng']);
});

test('planConversion - language filter matches keep-list aliases', () => {
  const result = plan(
    [audioStream({ codec: 'ac3', language: 'deu' }), audioStream({ codec: 'ac3', language: 'eng', default: false })],
    { library: { keepLanguages: ['de'], keepOriginalLanguage: false } },
  );
  expect(audioOut(result).map((stream) => stream.language)).toEqual(['ger']);
});

test('planConversion - language filter never removes the last audio track', () => {
  const result = plan(
    [
      audioStream({ codec: 'dts', language: 'spa', default: true }),
      audioStream({ codec: 'ac3', language: 'ger', channels: 2, default: false }),
    ],
    { library: { keepLanguages: ['eng'], keepOriginalLanguage: false } },
  );
  expect(audioOut(result).map((stream) => [stream.language, stream.codec])).toEqual([['spa', 'ac3']]);
  expect(result.dropped.map((drop) => [drop.language, drop.reason])).toEqual([
    ['spa', 'incompatible_replaced'],
    ['ger', 'language_filter'],
  ]);
});

test('planConversion - undetermined audio is dropped when keepUndetermined is off', () => {
  const result = plan(
    [audioStream({ codec: 'ac3', language: 'eng' }), audioStream({ codec: 'ac3', language: null, default: false })],
    { library: { keepLanguages: ['eng'], keepUndetermined: false } },
  );
  expect(result.dropped.map((drop) => [drop.language, drop.reason])).toEqual([[null, 'language_filter']]);
});

test('planConversion - undetermined audio is kept when it is the only audio', () => {
  const result = plan([audioStream({ codec: 'ac3', language: null })], {
    library: { keepLanguages: ['eng'], keepUndetermined: false },
  });
  expect(result.action).toBe('skip');
  expect(audioOut(result)).toHaveLength(1);
});

test('planConversion - an empty keep list keeps every language', () => {
  const result = plan([
    audioStream({ codec: 'ac3', language: 'eng' }),
    audioStream({ codec: 'ac3', language: 'jpn', default: false }),
    subtitleStream({ language: 'kor' }),
  ]);
  expect(result.action).toBe('skip');
  expect(result.streams).toHaveLength(3);
});

test('planConversion - the default flag moves to the original-language track', () => {
  const result = plan(
    [
      audioStream({ codec: 'ac3', language: 'ger', default: true }),
      audioStream({ codec: 'ac3', language: 'eng', default: false }),
    ],
    { originalLanguage: 'eng' },
  );
  expect(result.action).toBe('remux');
  expect(audioOut(result).map((stream) => [stream.language, stream.default])).toEqual([
    ['ger', false],
    ['eng', true],
  ]);
  expect(result.reasons).toEqual(['default audio set to ac3 (eng)']);
});

test('planConversion - the source default wins among several original-language tracks', () => {
  const result = plan(
    [
      audioStream({ codec: 'ac3', language: 'eng', title: 'Commentary', default: false }),
      audioStream({ codec: 'ac3', language: 'eng', default: true }),
    ],
    { originalLanguage: 'eng' },
  );
  expect(result.action).toBe('skip');
  expect(audioOut(result).map((stream) => stream.default)).toEqual([false, true]);
});

test('planConversion - the source default is kept when the original language is unknown', () => {
  const result = plan([
    audioStream({ codec: 'ac3', language: 'ger', default: false }),
    audioStream({ codec: 'ac3', language: 'eng', default: true }),
  ]);
  expect(result.action).toBe('skip');
  expect(audioOut(result).map((stream) => stream.default)).toEqual([false, true]);
});

test('planConversion - several default-flagged tracks are cleaned up only when the file is written anyway', () => {
  const streams = [
    audioStream({ codec: 'dts', language: 'eng', default: true }),
    audioStream({ codec: 'ac3', language: 'ger', channels: 2, default: true }),
  ];
  const result = plan(streams, { originalLanguage: 'eng' });
  expect(audioOut(result).map((stream) => stream.default)).toEqual([true, false]);
  expect(plan([streams[1] as AudioStream, streams[1] as AudioStream]).action).toBe('skip');
});

test('planConversion - no default flags and the first track in the original language is skipped', () => {
  const result = plan(
    [
      audioStream({ codec: 'ac3', language: 'eng', default: false }),
      audioStream({ codec: 'ac3', language: 'ger', default: false }),
    ],
    { originalLanguage: 'eng' },
  );
  expect(result.action).toBe('skip');
});

test('planConversion - original language falls back to the first default audio track', () => {
  const result = plan(
    [
      audioStream({ codec: 'ac3', language: 'ger', default: false }),
      audioStream({ codec: 'ac3', language: 'spa', default: true }),
      audioStream({ codec: 'ac3', language: null, default: false }),
    ],
    { library: { fillMissingLanguage: 'original' } },
  );
  expect(audioOut(result).map((stream) => [stream.language, stream.retagged])).toEqual([
    ['ger', false],
    ['spa', false],
    ['spa', true],
  ]);
});

test('planConversion - titles and language tags are kept and languages normalised', () => {
  const result = plan([
    audioStream({ codec: 'ac3', language: 'fra', title: 'Français 5.1' }),
    subtitleStream({ language: 'de', title: 'Deutsch (forced)', forced: true }),
  ]);
  expect(result.streams.map((stream) => [stream.language, stream.title, stream.forced])).toEqual([
    ['fre', 'Français 5.1', false],
    ['ger', 'Deutsch (forced)', true],
  ]);
});

test.each([
  ['original', 'spa', 'spa'],
  ['ger', null, 'ger'],
  ['de', null, 'ger'],
  ['German', 'spa', 'ger'],
])('planConversion - fillMissingLanguage %s (original %s) tags untagged tracks %s', (fill, original, expected) => {
  const result = plan([audioStream({ codec: 'ac3', language: null }), subtitleStream({ language: null })], {
    library: { fillMissingLanguage: fill },
    originalLanguage: original,
  });
  expect(result.action).toBe('remux');
  expect(result.streams.map((stream) => [stream.language, stream.retagged])).toEqual([
    [expected, true],
    [expected, true],
  ]);
  expect(result.reasons).toEqual([`audio stream 0 tagged ${expected}`, `subtitle stream 1 tagged ${expected}`]);
});

test.each([
  ['off', 'spa'],
  ['original', null],
  ['xx-invalid-tag', null],
])('planConversion - fillMissingLanguage %s (original %s) leaves untagged tracks alone', (fill, original) => {
  const result = plan([audioStream({ codec: 'ac3', language: null })], {
    library: { fillMissingLanguage: fill },
    originalLanguage: original,
  });
  expect(result.action).toBe('skip');
  expect(result.streams[0]).toMatchObject({ language: null, retagged: false });
});

test('planConversion - filled language tags count for the keep-list filter', () => {
  const result = plan(
    [audioStream({ codec: 'ac3', language: null }), audioStream({ codec: 'ac3', language: 'ger', default: false })],
    {
      library: { fillMissingLanguage: 'original', keepLanguages: ['spa'], keepUndetermined: false },
      originalLanguage: 'spa',
    },
  );
  expect(audioOut(result).map((stream) => stream.language)).toEqual(['spa']);
});

test('planConversion - video outside the profile blocks the plan', () => {
  const profile = resolveEffectiveProfile([
    deviceProfile(2, {
      ...templateDefinition('basic'),
      video: { allowedCodecs: ['h264', 'hevc'], dolbyVision: 'drop_hdr10' },
    }),
  ]);
  const result = plan([videoStream({ codec: 'vc1' }), audioStream({ codec: 'dts' })], { profile });
  expect(result.action).toBe('blocked');
  expect(result.failingCodecs).toEqual(['dts', 'video:vc1']);
  expect(result.reasons).toContain('video vc1 not decoded by profile (video is never re-encoded)');
  expect(result.estimatedOutputBytes).toBeNull();
});

test('planConversion - attached pictures never block the plan', () => {
  const result = plan([
    videoStream(),
    audioStream({ codec: 'ac3' }),
    videoStream({ codec: 'mjpeg', attachedPicture: true }),
  ]);
  expect(result.action).toBe('skip');
  expect(result.lostFeatures).toEqual([]);
});

test('planConversion - attached pictures are dropped with a recorded loss when the file is rewritten', () => {
  const result = plan([
    videoStream(),
    audioStream({ codec: 'dts' }),
    videoStream({ index: 2, codec: 'mjpeg', attachedPicture: true }),
  ]);
  expect(result.action).toBe('convert');
  expect(result.streams.map((stream) => stream.codec)).toEqual(['h264', 'ac3']);
  expect(result.dropped).toEqual([
    { sourceIndex: 1, kind: 'audio', codec: 'dts', language: 'eng', reason: 'incompatible_replaced' },
    { sourceIndex: 2, kind: 'video', codec: 'mjpeg', language: null, reason: 'unsupported' },
  ]);
  expect(result.lostFeatures).toContain('cover art dropped');
});

test('planConversion - data streams are dropped without forcing a rewrite', () => {
  const result = plan([videoStream(), audioStream({ codec: 'ac3' }), dataStream()]);
  expect(result.action).toBe('skip');
  expect(result.dropped).toEqual([
    { sourceIndex: 2, kind: 'data', codec: 'bin_data', language: null, reason: 'unsupported' },
  ]);
});

test('planConversion - dolby vision profile 5 is noted', () => {
  const dolbyVision = {
    profile: 5,
    level: 6,
    rpuPresent: true,
    elPresent: false,
    blPresent: true,
    blSignalCompatibilityId: 0,
  };
  const result = plan([
    videoStream({ codec: 'hevc', hdr: 'dolby_vision', dolbyVision }),
    audioStream({ codec: 'ac3' }),
  ]);
  expect(result.videoNotes).toEqual(['Dolby Vision profile 5 has no HDR10 fallback']);
});

test('planConversion - audio-only file without audio tracks is skipped', () => {
  expect(plan([videoStream()]).action).toBe('skip');
});

test('planConversion - estimated output subtracts replaced audio and adds the encode', () => {
  const result = plan([videoStream(), audioStream({ codec: 'dts', bitRate: 1_509_000 })], {
    durationSec: 100,
    sizeBytes: 1_000_000_000,
  });
  expect(result.estimatedOutputBytes).toBe(1_000_000_000 - 18_862_500 + 8_000_000);
});

test('planConversion - estimated output keeps the source size when bitrates are unknown', () => {
  const result = plan([audioStream({ codec: 'dts' })], { durationSec: 100, sizeBytes: 1_000_000_000 });
  expect(result.estimatedOutputBytes).toBe(1_008_000_000);
});

test('planConversion - carries the rules key of profile and library', () => {
  const result = plan([audioStream({ codec: 'ac3' })]);
  expect(result.rulesKey).toBe(computeRulesKey(TIZEN, LIBRARY));
});

test('planConversion - is pure: identical input gives identical output', () => {
  const streams = [videoStream(), audioStream({ codec: 'truehd', objectAudio: 'atmos', channels: 8 })];
  expect(plan(streams)).toEqual(plan(streams));
});

test('resolveEffectiveProfile - one profile keeps its definition', () => {
  const definition = templateDefinition('basic');
  const result = resolveEffectiveProfile([deviceProfile(1, definition, 3)]);
  expect(result).toEqual({ profileIds: [1], versionKey: '1@3', definition });
});

test('resolveEffectiveProfile - several profiles give the strictest combination', () => {
  const living = withAudio({
    allowedCodecs: ['ac3', 'eac3', 'aac', 'mp3'],
    targetCodec: 'eac3',
    bitrates: { mono: 256, stereo: 448, surround: 768 },
    maxChannels: 8,
  });
  const bedroom = withAudio({
    allowedCodecs: ['ac3', 'aac'],
    targetCodec: 'ac3',
    bitrates: { mono: 192, stereo: 384, surround: 640 },
    maxChannels: 6,
  });
  const result = resolveEffectiveProfile([deviceProfile(4, living), deviceProfile(3, bedroom, 2)]);
  expect(result.profileIds).toEqual([3, 4]);
  expect(result.versionKey).toBe('3@2+4@1');
  expect(result.definition.audio).toEqual({
    allowedCodecs: ['ac3', 'aac'],
    targetCodec: 'ac3',
    bitrates: { mono: 192, stereo: 384, surround: 640 },
    maxChannels: 6,
  });
});

test('resolveEffectiveProfile - keeps the first profile target codec when every profile allows it', () => {
  const a = withAudio({ allowedCodecs: ['ac3', 'aac'], targetCodec: 'aac' });
  const b = withAudio({ allowedCodecs: ['ac3', 'aac', 'eac3'], targetCodec: 'ac3' });
  expect(resolveEffectiveProfile([deviceProfile(1, a), deviceProfile(2, b)]).definition.audio.targetCodec).toBe('aac');
});

test.each([
  [
    ['pcm_*', 'ac3'],
    ['pcm_s16le', 'ac3'],
    ['ac3', 'pcm_s16le'],
  ],
  [['pcm_*'], ['pcm_*', 'pcm_s24le'], ['pcm_*']],
  [['pcm_s*'], ['pcm_*'], ['pcm_s*']],
  [['AC3', 'DTS'], ['ac3'], ['ac3']],
  [['ac3'], ['aac'], []],
])('resolveEffectiveProfile - audio codecs %j and %j intersect to %j', (first, second, expected) => {
  const result = resolveEffectiveProfile([
    deviceProfile(1, withAudio({ allowedCodecs: first })),
    deviceProfile(2, withAudio({ allowedCodecs: second })),
  ]);
  expect(result.definition.audio.allowedCodecs).toEqual(expected);
});

test('resolveEffectiveProfile - intersects video and subtitle codecs', () => {
  const base = templateDefinition('basic');
  const strict: DeviceProfileDefinition = {
    ...base,
    video: { allowedCodecs: ['h264', 'hevc', 'av1'], dolbyVision: 'drop_hdr10' },
    subtitles: { allowedCodecs: ['subrip'] },
  };
  const result = resolveEffectiveProfile([deviceProfile(1, base), deviceProfile(2, strict)]);
  expect(result.definition.video.allowedCodecs).toEqual(['h264', 'hevc', 'av1']);
  expect(result.definition.subtitles.allowedCodecs).toEqual(['subrip']);
});

test('resolveEffectiveProfile - falls back to a target codec every profile allows', () => {
  const a = withAudio({ allowedCodecs: ['eac3', 'aac'], targetCodec: 'eac3' });
  const b = withAudio({ allowedCodecs: ['aac'], targetCodec: 'aac' });
  expect(resolveEffectiveProfile([deviceProfile(1, a), deviceProfile(2, b)]).definition.audio.targetCodec).toBe('aac');
});

test('resolveEffectiveProfile - strictest profile is what the engine applies', () => {
  const stereoOnly = withAudio({ maxChannels: 2 });
  const profile = resolveEffectiveProfile([
    deviceProfile(1, templateDefinition('basic')),
    deviceProfile(2, stereoOnly),
  ]);
  const result = plan([audioStream({ codec: 'dts', channels: 6 })], { profile });
  expect(onlyEncode(result)).toMatchObject({ channels: 2, bitrateKbps: 448 });
});

test.each([
  [[audioStream({ codec: 'ac3', channels: 6 })], 'blocked'],
  [[audioStream({ codec: 'aac', channels: 2 })], 'blocked'],
  [[audioStream({ codec: 'dts', channels: 6 })], 'blocked'],
  [[audioStream({ codec: 'mp3', channels: 2 })], 'skip'],
  [[audioStream({ codec: 'dts' }), audioStream({ codec: 'mp3', channels: 6, default: false })], 'remux'],
] as const)('resolveEffectiveProfile - profiles without a common target codec never re-encode %j', (audio, action) => {
  const profile = resolveEffectiveProfile([
    deviceProfile(1, withAudio({ allowedCodecs: ['ac3', 'mp3'], targetCodec: 'ac3' })),
    deviceProfile(2, withAudio({ allowedCodecs: ['aac', 'mp3'], targetCodec: 'aac' })),
  ]);
  const result = plan([videoStream(), ...audio], { profile });
  expect(result.action).toBe(action);
  expect(result.reasons.includes('assigned profiles share no audio target codec (ac3 is not allowed by all)')).toBe(
    action === 'blocked',
  );
});

test.each([
  [
    ['ac3', 'aac'],
    ['eac3', 'aac', 'ac3'],
  ],
  [['ac3'], ['ac3', 'eac3']],
  [['aac', 'mp3'], ['aac']],
  [['eac3', 'ac3'], ['eac3']],
] as const)('resolveEffectiveProfile - %j and %j converted output re-plans to skip', (first, second) => {
  const profile = resolveEffectiveProfile([
    deviceProfile(1, withAudio({ allowedCodecs: [...first], targetCodec: first[0] })),
    deviceProfile(2, withAudio({ allowedCodecs: [...second], targetCodec: second[0] })),
  ]);
  const encode = onlyEncode(plan([videoStream(), audioStream({ codec: 'truehd', channels: 8 })], { profile }));
  const output = [videoStream(), audioStream({ codec: encode?.codec, channels: encode?.channels })];
  expect(plan(output, { profile }).action).toBe('skip');
});

test('resolveEffectiveProfile - no profiles is an error', () => {
  expect(() => resolveEffectiveProfile([])).toThrow('at least one device profile');
});

test('computeRulesKey - encodes profile versions and every library rule setting', () => {
  expect(computeRulesKey({ ...TIZEN, versionKey: '1@3+4@1' }, LIBRARY)).toBe('r1;p1@3+4@1;m:replace;k:;o:1;u:1;f:off');
});

test('computeRulesKey - is stable across keep-list order and language aliases', () => {
  const a = computeRulesKey(TIZEN, { ...LIBRARY, keepLanguages: ['ger', 'eng'] });
  const b = computeRulesKey(TIZEN, { ...LIBRARY, keepLanguages: ['en', 'deu', 'eng'] });
  expect(a).toBe(b);
  expect(a).toContain('k:eng,ger');
});

test.each([
  ['mode', { mode: 'keep_both' as const }],
  ['keepLanguages', { keepLanguages: ['eng'] }],
  ['keepOriginalLanguage', { keepOriginalLanguage: false }],
  ['keepUndetermined', { keepUndetermined: false }],
  ['fillMissingLanguage', { fillMissingLanguage: 'original' }],
  ['fixed fillMissingLanguage', { fillMissingLanguage: 'spa' }],
])('computeRulesKey - changes with %s', (_name, change) => {
  expect(computeRulesKey(TIZEN, { ...LIBRARY, ...change })).not.toBe(computeRulesKey(TIZEN, LIBRARY));
});

test('computeRulesKey - changes with the profile version', () => {
  expect(computeRulesKey({ ...TIZEN, versionKey: '1@2' }, LIBRARY)).not.toBe(computeRulesKey(TIZEN, LIBRARY));
});

test('checkProfiles - one result per profile: the plan action alone and the streams it cannot decode', () => {
  const probe = probeResult([
    videoStream({ index: 0, codec: 'h264' }),
    audioStream({ index: 1, codec: 'dts', channels: 6, language: 'eng' }),
    audioStream({ index: 2, codec: 'ac3', channels: 2, language: 'eng', title: 'Commentary' }),
    subtitleStream({ index: 3, codec: 'hdmv_pgs_subtitle', language: 'eng' }),
  ]);
  const everything = deviceProfile(2, templateDefinition('everything'));
  const results = checkProfiles({
    probe,
    profiles: [deviceProfile(1, templateDefinition('basic')), everything],
    library: LIBRARY,
    originalLanguage: 'eng',
  });
  expect(results).toEqual([
    { profileId: 1, action: 'convert', failingCodecs: ['dts'], failingStreams: [1, 3] },
    { profileId: 2, action: 'skip', failingCodecs: [], failingStreams: [3] },
  ]);
});

test('checkProfiles - a compatible track of the same programme lets the file play despite a failing one', () => {
  const probe = probeResult([
    videoStream({ index: 0, codec: 'hevc' }),
    audioStream({ index: 1, codec: 'truehd', channels: 8, language: 'eng' }),
    audioStream({ index: 2, codec: 'ac3', channels: 6, language: 'eng' }),
  ]);
  const [result] = checkProfiles({
    probe,
    profiles: [deviceProfile(1, templateDefinition('basic'))],
    library: { ...LIBRARY, mode: 'keep_both' },
    originalLanguage: 'eng',
  });
  expect(result?.failingStreams).toEqual([1]);
  expect(result?.action).not.toBe('convert');
});

test('checkProfiles - video outside the profile blocks that profile only', () => {
  const probe = probeResult([videoStream({ index: 0, codec: 'vp8' }), audioStream({ index: 1, codec: 'aac' })]);
  const vp8 = withAudio({});
  vp8.video.allowedCodecs.push('vp8');
  const results = checkProfiles({
    probe,
    profiles: [deviceProfile(1, templateDefinition('basic')), deviceProfile(2, vp8)],
    library: LIBRARY,
    originalLanguage: null,
  });
  expect(results.map((result) => [result.profileId, result.action, result.failingStreams])).toEqual([
    [1, 'blocked', [0]],
    [2, 'skip', []],
  ]);
});

test('checkProfiles - no profiles, no results', () => {
  expect(checkProfiles({ probe: probeResult([]), profiles: [], library: LIBRARY, originalLanguage: null })).toEqual([]);
});
