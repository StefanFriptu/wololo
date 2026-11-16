import type {
  CodecAllowed,
  ComputeRulesKey,
  PlanConversion,
  ResolveEffectiveProfile,
  RulesInput,
} from '../../contracts/rules-ffmpeg.ts';
import type {
  AudioEncodeSpec,
  AudioStream,
  ConversionPlan,
  DeviceProfileDefinition,
  DroppedStream,
  Iso639_2,
  LibraryRuleSettings,
  MediaStream,
  PlanAction,
  PlannedStream,
  TargetAudioCodec,
} from '../../shared/domain.ts';
import { normalizeLanguage, sameLanguage } from '../../shared/language.ts';
import { selectBitrate } from '../ffmpeg/args.ts';

const RULES_ENGINE_VERSION = 1;

const TARGET_CODECS: readonly TargetAudioCodec[] = ['ac3', 'eac3', 'aac'];

const TARGET_MAX_CHANNELS: Readonly<Record<TargetAudioCodec, number>> = { ac3: 6, eac3: 6, aac: 8 };

const TARGET_MAX_SAMPLE_RATE: Readonly<Record<TargetAudioCodec, number>> = { ac3: 48000, eac3: 48000, aac: 96000 };

const TARGET_LABELS: Readonly<Record<TargetAudioCodec, string>> = { ac3: 'AC3', eac3: 'E-AC3', aac: 'AAC' };

const OUTPUT_LAYOUTS: Readonly<Record<number, string>> = {
  1: 'mono',
  2: 'stereo',
  3: '3.0',
  4: 'quad',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

const CHANNEL_LABELS: Readonly<Record<number, string>> = {
  1: '1.0',
  2: '2.0',
  3: '3.0',
  4: '4.0',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

const ROLE_TITLE =
  /\b(commentar(?:y|ies)|comments?|descri(?:ption|ptive|bed)|narrat\w*|karaoke|isolated|score|trivia|dvs)\b/i;

const DURATION_TOLERANCE_SEC = 5;

const DURATION_TOLERANCE_RATIO = 0.02;

const NAMED_LAYOUT_LABELS: Readonly<Record<string, string>> = { mono: '1.0', stereo: '2.0', quad: '4.0' };

const SOURCE_CODEC_LABELS: Readonly<Record<string, string>> = {
  dts: 'DTS',
  truehd: 'TrueHD',
  mlp: 'MLP',
  flac: 'FLAC',
  alac: 'ALAC',
  eac3: 'E-AC3',
};

export const codecAllowed: CodecAllowed = (codec, allowed) => {
  const name = codec.toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  });
};

function patternCovered(pattern: string, allowed: readonly string[]): boolean {
  if (!pattern.endsWith('*')) return codecAllowed(pattern, allowed);
  const prefix = pattern.slice(0, -1);
  return allowed.some((entry) => entry.endsWith('*') && prefix.startsWith(entry.slice(0, -1)));
}

function intersectCodecs(lists: readonly (readonly string[])[]): string[] {
  const lowered = lists.map((list) => list.map((codec) => codec.toLowerCase()));
  const candidates = [...new Set(lowered.flat())];
  const common = candidates.filter((codec) => lowered.every((list) => patternCovered(codec, list)));
  return common.filter(
    (codec) => !common.some((other) => other !== codec && other.endsWith('*') && patternCovered(codec, [other])),
  );
}

function minOf(values: readonly number[]): number {
  return Math.min(...values);
}

export const resolveEffectiveProfile: ResolveEffectiveProfile = (profiles) => {
  const [first] = profiles;
  if (!first) throw new Error('resolveEffectiveProfile needs at least one device profile');
  const definitions = profiles.map((profile) => profile.definition);
  const audioAllowed = intersectCodecs(definitions.map((definition) => definition.audio.allowedCodecs));
  const preferredTargets = [...definitions.map((definition) => definition.audio.targetCodec), ...TARGET_CODECS];
  const targetCodec =
    preferredTargets.find((codec) => codecAllowed(codec, audioAllowed)) ?? first.definition.audio.targetCodec;
  const byId = [...profiles].sort((a, b) => a.id - b.id);

  return {
    profileIds: byId.map((profile) => profile.id),
    versionKey: byId.map((profile) => `${profile.id}@${profile.version}`).join('+'),
    definition: {
      audio: {
        allowedCodecs: audioAllowed,
        targetCodec,
        bitrates: {
          mono: minOf(definitions.map((definition) => definition.audio.bitrates.mono)),
          stereo: minOf(definitions.map((definition) => definition.audio.bitrates.stereo)),
          surround: minOf(definitions.map((definition) => definition.audio.bitrates.surround)),
        },
        maxChannels: minOf(definitions.map((definition) => definition.audio.maxChannels)),
      },
      video: {
        allowedCodecs: intersectCodecs(definitions.map((definition) => definition.video.allowedCodecs)),
        dolbyVision: first.definition.video.dolbyVision,
      },
      subtitles: {
        allowedCodecs: intersectCodecs(definitions.map((definition) => definition.subtitles.allowedCodecs)),
      },
      container: 'mkv',
    },
  };
};

function fillLanguageKey(fill: LibraryRuleSettings['fillMissingLanguage']): string {
  if (fill === 'off' || fill === 'original') return fill;
  return normalizeLanguage(fill) ?? 'off';
}

export const computeRulesKey: ComputeRulesKey = (profile, library) => {
  const languages = [
    ...new Set(library.keepLanguages.map(normalizeLanguage).filter((code): code is Iso639_2 => code !== null)),
  ].sort();
  return [
    `r${RULES_ENGINE_VERSION}`,
    `p${profile.versionKey}`,
    `m:${library.mode}`,
    `k:${languages.join(',')}`,
    `o:${library.keepOriginalLanguage ? 1 : 0}`,
    `u:${library.keepUndetermined ? 1 : 0}`,
    `f:${fillLanguageKey(library.fillMissingLanguage)}`,
  ].join(';');
};

interface Track<S extends MediaStream = MediaStream> {
  stream: S;
  language: Iso639_2 | null;
  retagged: boolean;
}

type AudioTrack = Track<AudioStream>;

type AudioDecision =
  | { outcome: 'filtered'; track: AudioTrack }
  | { outcome: 'copy'; track: AudioTrack }
  | { outcome: 'duplicate'; track: AudioTrack; duplicateOf: AudioTrack }
  | { outcome: 'encode'; track: AudioTrack; encode: AudioEncodeSpec };

interface StreamOutcome {
  streams: PlannedStream[];
  drops: DroppedStream[];
  reasons: string[];
  losses: string[];
}

const isAudioTrack = (track: Track): track is AudioTrack => track.stream.kind === 'audio';

function sourceDefaultAudio<T extends { default: boolean }>(streams: readonly T[]): T | undefined {
  return streams.find((stream) => stream.default) ?? streams[0];
}

function fallbackOriginalLanguage(streams: readonly MediaStream[]): Iso639_2 | null {
  const audio = streams.filter((stream) => stream.kind === 'audio');
  const tagged = audio.filter((stream) => normalizeLanguage(stream.language) !== null);
  return normalizeLanguage(sourceDefaultAudio(audio)?.language) ?? normalizeLanguage(tagged[0]?.language);
}

function fillLanguage(fill: LibraryRuleSettings['fillMissingLanguage'], original: Iso639_2 | null): Iso639_2 | null {
  if (fill === 'off') return null;
  if (fill === 'original') return original;
  return normalizeLanguage(fill);
}

function toTrack(stream: MediaStream, fill: Iso639_2 | null): Track {
  const language = normalizeLanguage(stream.language);
  const fillable = stream.kind === 'audio' || stream.kind === 'subtitle';
  if (language !== null || !fillable || fill === null) return { stream, language, retagged: false };
  return { stream, language: fill, retagged: true };
}

function sameGroup(a: Iso639_2 | null, b: Iso639_2 | null): boolean {
  return a === null ? b === null : sameLanguage(a, b);
}

function languageKept(language: Iso639_2 | null, library: LibraryRuleSettings, original: Iso639_2 | null): boolean {
  if (library.keepLanguages.length === 0) return true;
  if (language === null) return library.keepUndetermined;
  if (library.keepOriginalLanguage && sameLanguage(language, original)) return true;
  return library.keepLanguages.some((keep) => sameLanguage(keep, language));
}

function keptAudio(tracks: readonly AudioTrack[], library: LibraryRuleSettings, original: Iso639_2 | null) {
  const kept = tracks.filter((track) => languageKept(track.language, library, original));
  if (kept.length > 0 || tracks.length === 0) return new Set(kept);
  const anchor = sourceDefaultAudio(tracks.map((track) => track.stream));
  const anchorTrack = tracks.find((track) => track.stream === anchor);
  return new Set(tracks.filter((track) => sameGroup(track.language, anchorTrack?.language ?? null)));
}

function hasRole(title: string | null): boolean {
  return title !== null && ROLE_TITLE.test(title);
}

function similarDuration(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  const tolerance = Math.max(DURATION_TOLERANCE_SEC, Math.max(a, b) * DURATION_TOLERANCE_RATIO);
  return Math.abs(a - b) <= tolerance;
}

/** keep_both drops nothing on a match, so two untagged tracks may pair; replace would drop a real untagged dub. */
function samePresentation(track: AudioTrack, other: AudioTrack, mode: LibraryRuleSettings['mode']): boolean {
  if (hasRole(track.stream.title) || hasRole(other.stream.title)) return false;
  const languageMatches = mode === 'keep_both' ? sameGroup : sameLanguage;
  if (!languageMatches(track.language, other.language)) return false;
  return similarDuration(track.stream.durationSec, other.stream.durationSec);
}

function encodeSpec(stream: AudioStream, audio: DeviceProfileDefinition['audio']): AudioEncodeSpec {
  const sourceChannels = Math.max(1, stream.channels);
  const channels = Math.max(1, Math.min(sourceChannels, audio.maxChannels, TARGET_MAX_CHANNELS[audio.targetCodec]));
  const downmixed = channels < sourceChannels;
  return {
    codec: audio.targetCodec,
    bitrateKbps: selectBitrate(channels, audio.bitrates),
    channels,
    channelLayout: (downmixed ? null : stream.channelLayout) ?? OUTPUT_LAYOUTS[channels] ?? `${channels}c`,
    downmixed,
  };
}

function decideAudio(
  tracks: readonly AudioTrack[],
  definition: DeviceProfileDefinition,
  library: LibraryRuleSettings,
  original: Iso639_2 | null,
): AudioDecision[] {
  const kept = keptAudio(tracks, library, original);
  const compatible = (track: AudioTrack) => codecAllowed(track.stream.codec, definition.audio.allowedCodecs);
  return tracks.map((track): AudioDecision => {
    if (!kept.has(track)) return { outcome: 'filtered', track };
    if (compatible(track)) return { outcome: 'copy', track };
    const encode = encodeSpec(track.stream, definition.audio);
    const duplicateOf = [...kept].find(
      (other) =>
        compatible(other) && other.stream.channels >= encode.channels && samePresentation(track, other, library.mode),
    );
    if (duplicateOf) return { outcome: 'duplicate', track, duplicateOf };
    return { outcome: 'encode', track, encode };
  });
}

function layoutLabel(channels: number, layout: string | null): string {
  const name = (layout ?? '').replace(/\(.*\)$/, '');
  const numeric = /^\d\.\d$/.test(name) ? name : null;
  return numeric ?? NAMED_LAYOUT_LABELS[name] ?? CHANNEL_LABELS[channels] ?? `${channels} channels`;
}

function describeAudio(track: AudioTrack): string {
  const { stream } = track;
  return `${stream.codec} (${track.language ?? 'und'}, ${layoutLabel(stream.channels, stream.channelLayout)})`;
}

function sourceCodecLabel(stream: AudioStream): string {
  if (stream.codec === 'dts' && stream.profile) return stream.profile;
  if (stream.codec.startsWith('pcm_')) return 'LPCM';
  return SOURCE_CODEC_LABELS[stream.codec] ?? stream.codec;
}

function objectAudioLoss(stream: AudioStream): string[] {
  if (stream.objectAudio === 'atmos') return ['Atmos height channels dropped'];
  if (stream.objectAudio === 'dtsx') return ['DTS:X height channels dropped'];
  return [];
}

function encodeLosses(stream: AudioStream, encode: AudioEncodeSpec): string[] {
  const target = `${TARGET_LABELS[encode.codec]} ${encode.bitrateKbps} kbps`;
  const losses = objectAudioLoss(stream);
  if (encode.downmixed) {
    losses.push(
      `${layoutLabel(stream.channels, stream.channelLayout)} downmixed to ${layoutLabel(encode.channels, encode.channelLayout)}`,
    );
  }
  if (stream.lossless) losses.push(`Lossless ${sourceCodecLabel(stream)} converted to ${target}`);
  if (stream.sampleRate > TARGET_MAX_SAMPLE_RATE[encode.codec]) {
    losses.push(`${stream.sampleRate / 1000} kHz resampled to ${TARGET_MAX_SAMPLE_RATE[encode.codec] / 1000} kHz`);
  }
  return losses;
}

function duplicateLosses(stream: AudioStream, kept: AudioStream): string[] {
  const losses = objectAudioLoss(stream);
  if (stream.channels > kept.channels) {
    losses.push(
      `${layoutLabel(stream.channels, stream.channelLayout)} downmixed to ${layoutLabel(kept.channels, kept.channelLayout)}`,
    );
  }
  if (stream.lossless && !kept.lossless) losses.push(`Lossless ${sourceCodecLabel(stream)} dropped for ${kept.codec}`);
  return losses;
}

function plannedCopy(track: Track): PlannedStream {
  const { stream } = track;
  return {
    sourceIndex: stream.index,
    kind: stream.kind,
    op: 'copy',
    codec: stream.codec,
    encode: null,
    language: track.language,
    retagged: track.retagged,
    title: stream.title,
    default: stream.default,
    forced: stream.forced,
  };
}

function plannedEncode(track: AudioTrack, encode: AudioEncodeSpec): PlannedStream {
  return { ...plannedCopy(track), op: 'encode', codec: encode.codec, encode };
}

function dropped(track: Track, reason: DroppedStream['reason']): DroppedStream {
  return {
    sourceIndex: track.stream.index,
    kind: track.stream.kind,
    codec: track.stream.codec,
    language: track.language,
    reason,
  };
}

function outcome(parts: Partial<StreamOutcome>): StreamOutcome {
  return { streams: [], drops: [], reasons: [], losses: [], ...parts };
}

function audioOutcome(decision: AudioDecision, mode: LibraryRuleSettings['mode']): StreamOutcome {
  const { track } = decision;
  const label = describeAudio(track);
  const keepBoth = mode === 'keep_both';
  if (decision.outcome === 'filtered') {
    return outcome({
      drops: [dropped(track, 'language_filter')],
      reasons: [`audio ${label} removed by language filter`],
    });
  }
  if (decision.outcome === 'copy') return outcome({ streams: [plannedCopy(track)] });
  if (decision.outcome === 'duplicate') {
    const kept = describeAudio(decision.duplicateOf);
    if (keepBoth) {
      return outcome({
        streams: [plannedCopy(track)],
        reasons: [`${label} demoted: compatible ${kept} in the same language`],
      });
    }
    return outcome({
      drops: [dropped(track, 'compatible_duplicate')],
      reasons: [`${label} dropped: compatible ${kept} in the same language`],
      losses: duplicateLosses(track.stream, decision.duplicateOf.stream),
    });
  }
  const { encode } = decision;
  const target = `${encode.codec} ${layoutLabel(encode.channels, encode.channelLayout)} ${encode.bitrateKbps} kbps`;
  const reasons = [`${label} not decoded by profile, converted to ${target}`];
  if (keepBoth) return outcome({ streams: [plannedEncode(track, encode), plannedCopy(track)], reasons });
  return outcome({
    streams: [plannedEncode(track, encode)],
    drops: [dropped(track, 'incompatible_replaced')],
    reasons,
    losses: encodeLosses(track.stream, encode),
  });
}

function otherOutcome(track: Track, library: LibraryRuleSettings, original: Iso639_2 | null): StreamOutcome {
  const { stream } = track;
  if (stream.kind === 'data') return outcome({ drops: [dropped(track, 'unsupported')] });
  if (stream.kind === 'video' && stream.attachedPicture)
    return outcome({ drops: [dropped(track, 'unsupported')], losses: ['cover art dropped'] });
  if (stream.kind === 'subtitle' && !languageKept(track.language, library, original)) {
    return outcome({
      drops: [dropped(track, 'language_filter')],
      reasons: [`subtitle ${stream.codec} (${track.language ?? 'und'}) removed by language filter`],
    });
  }
  return outcome({ streams: [plannedCopy(track)] });
}

function chooseDefaultAudio(
  output: readonly PlannedStream[],
  allowed: readonly string[],
  original: Iso639_2 | null,
  sourceDefaultIndex: number | null,
): PlannedStream | undefined {
  const audio = output.filter((stream) => stream.kind === 'audio');
  const decodable = audio.filter((stream) => stream.op === 'encode' || codecAllowed(stream.codec, allowed));
  const main = decodable.filter((stream) => !hasRole(stream.title));
  const playable = main.length > 0 ? main : decodable;
  const originals = playable.filter((stream) => sameLanguage(stream.language, original));
  const pool = originals.length > 0 ? originals : playable;
  return pool.find((stream) => stream.sourceIndex === sourceDefaultIndex) ?? pool[0] ?? audio[0];
}

function leadAudioWith(streams: readonly PlannedStream[], lead: PlannedStream): PlannedStream[] {
  const firstAudio = streams.findIndex((stream) => stream.kind === 'audio');
  const rest = streams.filter((stream) => stream !== lead);
  return [...rest.slice(0, firstAudio), lead, ...rest.slice(firstAudio)];
}

function streamBytes(stream: MediaStream, durationSec: number): number {
  if (stream.bitRate == null) return 0;
  return (stream.bitRate * (stream.durationSec ?? durationSec)) / 8;
}

function estimateOutputBytes(input: RulesInput, output: readonly PlannedStream[], drops: readonly DroppedStream[]) {
  const { probe } = input;
  const bySourceIndex = new Map(probe.streams.map((stream) => [stream.index, stream]));
  const removed = drops.reduce((sum, drop) => {
    const stream = bySourceIndex.get(drop.sourceIndex);
    return sum + (stream ? streamBytes(stream, probe.durationSec) : 0);
  }, 0);
  const added = output.reduce(
    (sum, stream) => sum + (stream.encode ? (stream.encode.bitrateKbps * 1000 * probe.durationSec) / 8 : 0),
    0,
  );
  return Math.max(0, Math.round(probe.sizeBytes - removed + added));
}

function blockedVideo(streams: readonly MediaStream[], allowed: readonly string[]): string[] {
  return streams
    .filter((stream) => stream.kind === 'video' && !stream.attachedPicture && !codecAllowed(stream.codec, allowed))
    .map((stream) => stream.codec);
}

function dolbyVisionNotes(streams: readonly MediaStream[]): string[] {
  return streams.flatMap((stream) => {
    if (stream.kind !== 'video' || !stream.dolbyVision) return [];
    if (stream.dolbyVision.profile === 5) return ['Dolby Vision profile 5 has no HDR10 fallback'];
    return [];
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export const planConversion: PlanConversion = (input) => {
  const { probe, profile, library } = input;
  const { definition } = profile;
  const original = normalizeLanguage(input.originalLanguage) ?? fallbackOriginalLanguage(probe.streams);
  const tracks = probe.streams.map((stream) => toTrack(stream, fillLanguage(library.fillMissingLanguage, original)));
  const decisions = decideAudio(tracks.filter(isAudioTrack), definition, library, original);
  const decisionBySource = new Map(decisions.map((decision) => [decision.track.stream.index, decision]));

  const outcomes = tracks.map((track) => {
    const decision = decisionBySource.get(track.stream.index);
    return decision ? audioOutcome(decision, library.mode) : otherOutcome(track, library, original);
  });
  const output = outcomes.flatMap((outcome) => outcome.streams);
  const drops = outcomes.flatMap((outcome) => outcome.drops);
  const reasons = outcomes.flatMap((outcome) => outcome.reasons);
  const lostFeatures = outcomes.flatMap((outcome) => outcome.losses);

  const sourceDefault = sourceDefaultAudio(probe.streams.filter((stream) => stream.kind === 'audio'));
  const chosen = chooseDefaultAudio(output, definition.audio.allowedCodecs, original, sourceDefault?.index ?? null);
  const flagged = output.map((stream) =>
    stream.kind === 'audio' ? { ...stream, default: stream === chosen } : stream,
  );
  const lead = flagged.find((stream) => stream.default && stream.op === 'encode');
  const streams = library.mode === 'keep_both' && lead ? leadAudioWith(flagged, lead) : flagged;
  const defaultChanged =
    chosen !== undefined && sourceDefault !== undefined && chosen.sourceIndex !== sourceDefault.index;
  if (defaultChanged) reasons.push(`default audio set to ${chosen.codec} (${chosen.language ?? 'und'})`);

  const retagged = streams.filter((stream) => stream.retagged);
  for (const stream of retagged) reasons.push(`${stream.kind} stream ${stream.sourceIndex} tagged ${stream.language}`);

  const videoCodecs = blockedVideo(probe.streams, definition.video.allowedCodecs);
  for (const codec of videoCodecs) reasons.push(`video ${codec} not decoded by profile (video is never re-encoded)`);

  const encodes = streams.some((stream) => stream.op === 'encode');
  const { targetCodec, allowedCodecs } = definition.audio;
  const noTarget = encodes && !codecAllowed(targetCodec, allowedCodecs);
  if (noTarget) reasons.push(`assigned profiles share no audio target codec (${targetCodec} is not allowed by all)`);
  const rewrites = drops.some((drop) => drop.reason !== 'unsupported') || retagged.length > 0 || defaultChanged;
  const blocked = videoCodecs.length > 0 || noTarget;
  const action: PlanAction = blocked ? 'blocked' : encodes ? 'convert' : rewrites ? 'remux' : 'skip';

  const failingAudio = decisions
    .filter((decision) => decision.outcome === 'encode' || decision.outcome === 'duplicate')
    .map((decision) => decision.track.stream.codec);

  const plan: ConversionPlan = {
    action,
    reasons: action === 'skip' ? [] : reasons,
    failingCodecs: action === 'skip' ? [] : unique([...failingAudio, ...videoCodecs.map((codec) => `video:${codec}`)]),
    streams,
    dropped: drops,
    lostFeatures: action === 'skip' ? [] : unique(lostFeatures),
    videoNotes: unique(dolbyVisionNotes(probe.streams)),
    estimatedOutputBytes:
      action === 'convert' || action === 'remux' ? estimateOutputBytes(input, streams, drops) : null,
    rulesKey: computeRulesKey(profile, library),
  };
  return plan;
};
