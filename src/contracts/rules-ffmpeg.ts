/**
 * Contract: rules-ffmpeg module (src/modules/profiles, src/modules/rules, src/modules/ffmpeg).
 * Owns writes to: device_profiles.
 * planConversion, resolveEffectiveProfile, buildAudioConversionArgs and createProgressParser are PURE
 * (no I/O, no clock, no randomness) and table-tested per codec and channel layout.
 */
import type { CodecCatalog, ProfileInput, ProfileWithUsage } from '../shared/api-types.ts';
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
  /**
   * ISO 639-2/B from Radarr/Sonarr (normalised); when null the engine falls back to the first default audio track's
   * language, then to the first tagged audio track.
   */
  originalLanguage: string | null;
}

/**
 * Pure. Decides per stream: copy, encode (target codec/bitrate/channels) or drop. Implements:
 * - skip conversion when a compatible track of the same programme exists: same tagged language (sameLanguage, so
 *   untagged tracks never match; fillMissingLanguage tags them first), >= target channels, neither title names a role
 *   (commentary, description, descriptive, narration, karaoke, isolated, score, trivia, DVS) and durations within
 *   max(5 s, 2 %) when both are known (drop/demote the incompatible one); otherwise encode,
 * - Replace (only converted track) vs KeepBoth (each converted track is written before its original; the default
 *   converted track moves to the first audio position, every other audio stream keeps source order),
 * - fillMissingLanguage first (untagged audio/subtitle -> original or fixed language, PlannedStream.retagged = true),
 * - language keep-list + original language, never removes the last audio track; every language comparison goes
 *   through sameLanguage/normalizeLanguage (src/shared/language.ts), so "ger", "deu" and "de" match,
 * - default flag on the original-language track, never on a role-titled track (commentary, description, ...) while
 *   another playable track exists; titles and language tags kept,
 * - video codec outside profile.video.allowedCodecs -> action "blocked" (video is never re-encoded in v1),
 * - an encode whose target codec is not in profile.audio.allowedCodecs (assigned profiles share no target) -> action
 *   "blocked" with reason "assigned profiles share no audio target codec (<codec> is not allowed by all)"; files
 *   needing no encode still skip or remux,
 * - lost-feature notes ("Atmos height channels dropped", "7.1 downmixed to 5.1"),
 * - no resample, no normalisation.
 */
export type PlanConversion = (input: RulesInput) => ConversionPlan;

/**
 * Pure. Strictest combination: intersection of allowed codecs, min maxChannels; target codec: the first profile's when
 * it is allowed by all, else the first of the profiles' targets then ac3/eac3/aac allowed by all; when none is, the
 * first profile's target is kept and planConversion blocks.
 */
export type ResolveEffectiveProfile = (profiles: DeviceProfile[]) => EffectiveProfile;

/** Pure. Stable key of effective profile versions + every LibraryRuleSettings field, stored as media_files.rules_key. */
export type ComputeRulesKey = (profile: EffectiveProfile, library: LibraryRuleSettings) => string;

/** Pure. Does a codec name match an allowed list entry (supports "pcm_*" prefix wildcards)? */
export type CodecAllowed = (codec: string, allowed: readonly string[]) => boolean;

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
  /**
   * Options placed before -i, e.g. ["-playlist", "800"] when inputPath is "bluray:<disc>" (BDMV side files). With
   * inputOptions the output starts at 0 (no -copyts, no -itsoffset); the caller applies the audio/video offset with
   * mkvmerge --sync.
   */
  inputOptions?: string[];
  /**
   * Temp output in the same folder as the input ("<name>.wololo-tmp.mkv"), or a BDMV side file (".mka"). Must not exist
   * when ffmpeg starts: the caller lstat()s it and unlinks a leftover file or symlink first (the argv carries -y).
   */
  outputPath: string;
  probe: ProbeResult;
  /** Streams to write, in output order. BDMV passes a plan reduced to the one audio stream of a side file. */
  plan: ConversionPlan;
  /**
   * Write the planned language of every audio and subtitle stream. BDMV sets it: its probe carries the playlist
   * languages the disc streams lack. Otherwise only filled-in (retagged) languages are written and every other tag is
   * copied from the source unchanged ("fra" stays "fra", never rewritten to "fre").
   */
  tagAllLanguages?: boolean;
}

/**
 * Pure. Full ffmpeg argv WITHOUT the binary, e.g.
 * ["-hide_banner", "-nostdin", "-y", "-i", in, "-map", "0:0", ..., "-c:v", "copy", "-c:a:0", "ac3", "-b:a:0", "640k", "-ac:a:0", "6",
 *  "-map_chapters", "0", "-map_metadata", "0", "-disposition:a:0", "+default",
 *  "-progress", "pipe:1", "-nostats", "-f", "matroska", out]
 * Decoder options before -i: "-core_only 0" when a dts track is encoded (full DTS-HD MA, never the core), "-drc_scale 0"
 * when ac3/eac3 is decoded (no dynamic range compression). Output format from the extension (.mp4/.m4v -> mp4, else
 * matroska); ".mka" side files get "-map_chapters -1" so mkvmerge does not merge chapters twice. Encoded tracks get
 * stale mkvmerge statistics tags (BPS, NUMBER_OF_BYTES, ...) cleared. "+default"/"-default" toggle only the default
 * flag (other dispositions such as commentary stay).
 * Never adds -ar, loudnorm, or dynaudnorm. Throws when outputPath equals inputPath (after normalisation) or starts
 * with "-".
 */
export type BuildAudioConversionArgs = (input: AudioConversionInput) => string[];

/** Bitrate (kbps) for a target layout from the profile's bitrate table. */
export type SelectBitrate = (channels: number, bitrates: DeviceProfileDefinition['audio']['bitrates']) => number;

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
