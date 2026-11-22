import { codecAllowed, type DeviceProfileDefinition, maxBitrateKbps } from '#lib/shared.ts';

/** Mirrors the ProfileInputSchema audio rules, so the editor explains a save the server would refuse. */
export function audioProblems(audio: DeviceProfileDefinition['audio']): string[] {
  const target = audio.targetCodec.toUpperCase();
  const max = maxBitrateKbps(audio.targetCodec);
  const problems: string[] = [];
  if (!codecAllowed(audio.targetCodec, audio.allowedCodecs)) {
    problems.push(`Tick ${target} in "Codecs the device plays", or converted tracks would never pass this profile.`);
  }
  if (Object.values(audio.bitrates).some((kbps) => kbps > max)) {
    problems.push(`${target} bit rates cannot exceed ${max} kbps.`);
  }
  return problems;
}
