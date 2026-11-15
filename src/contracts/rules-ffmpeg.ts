/**
 * Contract: rules-ffmpeg module (src/modules/profiles, src/modules/rules, src/modules/ffmpeg).
 * Owns writes to: device_profiles.
 * planConversion, resolveEffectiveProfile, buildAudioConversionArgs and createProgressParser are PURE
 * (no I/O, no clock, no randomness) and table-tested per codec and channel layout.
 */
import type {
  CodecCatalog,
  ProfileInput,
  ProfileWithUsage,
} from '../shared/api-types.ts';
import type {
  ConversionPlan,
  DeviceProfile,
  DeviceProfileDefinition,
  EffectiveProfile,
  LibraryRuleSettings,
  ProbeResult,
} from '../shared/domain.ts';

// ---------- profiles ----------

export const DEFAULT_PROFILE_NAME = 'Samsung Tizen';

export interface ProfileService {
  list(): Promise<ProfileWithUsage[]>;
  get(id: number): Promise<ProfileWithUsage>;
  create(input: ProfileInput): Promise<ProfileWithUsage>;
  /** Bumps version when the definition changes, then calls media.invalidateRules({ profileId }). */
  update(id: number, input: ProfileInput): Promise<ProfileWithUsage>;
  /** AppError('conflict') when assigned to a library or builtin. */
  remove(id: number): Promise<void>;
  clone(id: number, name: string): Promise<ProfileWithUsage>;
  /** Seeds the builtin "Samsung Tizen" profile when no profile exists. Called once at startup; idempotent. */
  ensureDefaults(): Promise<void>;
  /** The builtin default profile, used for libraries without assigned profiles. */
  getDefault(): Promise<DeviceProfile>;
  codecCatalog(): CodecCatalog;
}

/** The "Samsung Tizen" definition from the spec's trigger table. */
export type DefaultProfileDefinition = () => DeviceProfileDefinition;

// ---------- rules engine ----------

export interface RulesInput {
  probe: ProbeResult;
  profile: EffectiveProfile;
  library: LibraryRuleSettings;
  /** From Radarr/Sonarr; when null the engine falls back to the first default audio track's language. */
  originalLanguage: string | null;
}

/**
 * Pure. Decides per stream: copy, encode (target codec/bitrate/channels) or drop. Implements:
 * - skip conversion when a compatible track in the same language with >= channels exists (drop/demote the incompatible one),
 * - Replace (only converted track) vs KeepBoth (converted first + default, original kept after),
 * - language keep-list + original language, never removes the last audio track,
 * - default flag on the original-language track, titles and language tags kept,
 * - lost-feature notes ("Atmos height channels dropped", "7.1 downmixed to 5.1"),
 * - no resample, no normalisation.
 */
export type PlanConversion = (input: RulesInput) => ConversionPlan;

/** Pure. Strictest combination: intersection of allowed codecs, min maxChannels, first profile's target codec when it is allowed by all. */
export type ResolveEffectiveProfile = (
  profiles: DeviceProfile[],
) => EffectiveProfile;

/** Pure. Stable key of effective profile versions + library rule settings, stored as media_files.rules_key. */
export type ComputeRulesKey = (
  profile: EffectiveProfile,
  library: LibraryRuleSettings,
) => string;

/** Pure. Does a codec name match an allowed list entry (supports "pcm_*" prefix wildcards)? */
export type CodecAllowed = (
  codec: string,
  allowed: readonly string[],
) => boolean;

export interface RulesService {
  plan(input: RulesInput): ConversionPlan;
  resolveProfile(profiles: DeviceProfile[]): EffectiveProfile;
  rulesKey(profile: EffectiveProfile, library: LibraryRuleSettings): string;
  /** Loads assigned profiles of a library (or the default profile) and resolves them. */
  effectiveProfileForLibrary(libraryId: number): Promise<EffectiveProfile>;
}

// ---------- ffmpeg command builder + progress ----------

export interface AudioConversionInput {
  inputPath: string;
  /** Temp output in the same folder as the input ("<name>.wololo-tmp.mkv"). */
  outputPath: string;
  probe: ProbeResult;
  plan: ConversionPlan;
}

/**
 * Pure. Full ffmpeg argv WITHOUT the binary, e.g.
 * ["-hide_banner", "-nostdin", "-y", "-i", in, "-map", "0:0", ..., "-c:v", "copy", "-c:a:0", "ac3", "-b:a:0", "640k", "-ac:a:0", "6",
 *  "-map_chapters", "0", "-map_metadata", "0", "-metadata:s:a:0", "language=eng", "-disposition:a:0", "default",
 *  "-progress", "pipe:1", "-nostats", "-f", "matroska", out]
 * Never adds -ar, loudnorm, or dynaudnorm. Lossless sources are decoded from the full stream (ffmpeg decodes DTS-HD MA fully).
 */
export type BuildAudioConversionArgs = (
  input: AudioConversionInput,
) => string[];

/** Bitrate (kbps) for a target layout from the profile's bitrate table. */
export type SelectBitrate = (
  channels: number,
  bitrates: DeviceProfileDefinition['audio']['bitrates'],
) => number;

export interface FfmpegProgress {
  outTimeSec: number;
  /** 0..1, clamped. */
  progress: number;
  /** Multiple of real time. */
  speed: number | null;
  etaSec: number | null;
  fps: number | null;
  totalSizeBytes: number | null;
  done: boolean;
}

export interface ProgressParser {
  /** Feed one stdout line of `-progress pipe:1`; returns an update at the end of each key=value block, else null. */
  push(line: string): FfmpegProgress | null;
}

export type CreateProgressParser = (durationSec: number) => ProgressParser;

export interface FfmpegService {
  buildAudioConversionArgs: BuildAudioConversionArgs;
  createProgressParser: CreateProgressParser;
}
