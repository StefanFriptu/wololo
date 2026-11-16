import type { DeviceProfileDefinition, TargetAudioCodec } from '#lib/shared.ts';
import { codecAllowedBy } from './codecAllowedBy.ts';

const AC3_MAX_KBPS = 640;
const MAX_KBPS = 1536;

export function maxBitrate(target: TargetAudioCodec): number {
  return target === 'ac3' ? AC3_MAX_KBPS : MAX_KBPS;
}

/** Mirrors the ProfileInputSchema audio rules, so the editor explains a save the server would refuse. */
export function audioProblems(audio: DeviceProfileDefinition['audio']): string[] {
  const target = audio.targetCodec.toUpperCase();
  const max = maxBitrate(audio.targetCodec);
  const problems: string[] = [];
  if (!codecAllowedBy(audio.allowedCodecs, audio.targetCodec)) {
    problems.push(`Tick ${target} in "Codecs the device plays", or converted tracks would never pass this profile.`);
  }
  if (Object.values(audio.bitrates).some((kbps) => kbps > max)) {
    problems.push(`${target} bit rates cannot exceed ${max} kbps.`);
  }
  return problems;
}
