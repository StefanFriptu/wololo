import { normalize } from 'node:path';
import type { BuildAudioConversionArgs, SelectBitrate } from '../../contracts/rules-ffmpeg.ts';
import type { MediaStream, PlannedStream, StreamKind } from '../../shared/domain.ts';

type OutputFormat = 'matroska' | 'mp4';

const STREAM_SPECIFIERS: Readonly<Record<StreamKind, string>> = {
  video: 'v',
  audio: 'a',
  subtitle: 's',
  attachment: 't',
  data: 'd',
};

const STATISTICS_TAGS = [
  'BPS',
  'DURATION',
  'NUMBER_OF_FRAMES',
  'NUMBER_OF_BYTES',
  '_STATISTICS_WRITING_APP',
  '_STATISTICS_WRITING_DATE_UTC',
  '_STATISTICS_TAGS',
] as const;

const MP4_TEXT_SUBTITLES = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'text']);

export const selectBitrate: SelectBitrate = (channels, bitrates) => {
  if (channels <= 1) return bitrates.mono;
  if (channels === 2) return bitrates.stereo;
  return bitrates.surround;
};

function outputFormat(path: string): OutputFormat {
  return /\.(mp4|m4v)$/i.test(path) ? 'mp4' : 'matroska';
}

function subtitleConversion(format: OutputFormat, codec: string): string | null {
  if (format === 'matroska') return codec === 'mov_text' ? 'srt' : null;
  return MP4_TEXT_SUBTITLES.has(codec) ? 'mov_text' : null;
}

function decoderOptions(encodedSources: readonly MediaStream[]): string[] {
  const codecs = new Set(encodedSources.map((stream) => stream.codec));
  const options: string[] = [];
  if (codecs.has('dts')) options.push('-core_only', '0');
  if (codecs.has('ac3') || codecs.has('eac3')) options.push('-drc_scale', '0');
  return options;
}

function encodeOptions(stream: PlannedStream, specifier: string): string[] {
  if (!stream.encode) return [];
  const { codec, bitrateKbps, channels } = stream.encode;
  const clearedTags = STATISTICS_TAGS.flatMap((tag) => [
    `-metadata:s:${specifier}`,
    `${tag}=`,
    `-metadata:s:${specifier}`,
    `${tag}-eng=`,
  ]);
  return [
    `-c:${specifier}`,
    codec,
    `-b:${specifier}`,
    `${bitrateKbps}k`,
    `-ac:${specifier}`,
    String(channels),
    ...clearedTags,
  ];
}

function streamOptions(stream: PlannedStream, specifier: string, format: OutputFormat): string[] {
  if (stream.kind === 'audio') {
    return [
      ...encodeOptions(stream, specifier),
      ...(stream.language ? [`-metadata:s:${specifier}`, `language=${stream.language}`] : []),
      `-disposition:${specifier}`,
      stream.default ? '+default' : '-default',
    ];
  }
  if (stream.kind === 'subtitle') {
    const conversion = subtitleConversion(format, stream.codec);
    return [
      ...(conversion ? [`-c:${specifier}`, conversion] : []),
      ...(stream.language ? [`-metadata:s:${specifier}`, `language=${stream.language}`] : []),
    ];
  }
  return [];
}

export const buildAudioConversionArgs: BuildAudioConversionArgs = ({
  inputPath,
  inputOptions = [],
  outputPath,
  probe,
  plan,
}) => {
  if (outputPath.startsWith('-')) throw new Error(`output path ${outputPath} would be read as an ffmpeg option`);
  if (normalize(outputPath) === normalize(inputPath)) throw new Error(`output path ${outputPath} is the input file`);
  const sources = new Map(probe.streams.map((stream) => [stream.index, stream]));
  const missing = plan.streams.find((stream) => sources.get(stream.sourceIndex)?.kind !== stream.kind);
  if (missing) {
    throw new Error(`planned ${missing.kind} stream ${missing.sourceIndex} is not in the probe of ${probe.path}`);
  }

  const format = outputFormat(outputPath);
  const encodedSources = plan.streams
    .filter((stream) => stream.op === 'encode')
    .flatMap((stream) => sources.get(stream.sourceIndex) ?? []);
  const counters = new Map<StreamKind, number>();
  const perStream = plan.streams.flatMap((stream) => {
    const position = counters.get(stream.kind) ?? 0;
    counters.set(stream.kind, position + 1);
    return streamOptions(stream, `${STREAM_SPECIFIERS[stream.kind]}:${position}`, format);
  });

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...decoderOptions(encodedSources),
    ...inputOptions,
    '-i',
    inputPath,
    ...plan.streams.flatMap((stream) => ['-map', `0:${stream.sourceIndex}`]),
    '-c',
    'copy',
    ...perStream,
    '-map_chapters',
    /\.mka$/i.test(outputPath) ? '-1' : '0',
    '-map_metadata',
    '0',
    '-max_muxing_queue_size',
    '4096',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    format,
    outputPath,
  ];
};
