import { nameById } from '#lib/nameById.ts';
import type { DeviceProfile } from '#lib/shared.ts';

export interface ConvertTarget {
  profileId: number | undefined;
  label: string;
}

export const STRICTEST_TARGET: ConvertTarget = { profileId: undefined, label: "Strictest of this library's players" };

/** Empty when there is no real choice (fewer than two players), so callers can skip asking. */
export function convertTargets(
  profileIds: readonly number[],
  profiles: ReadonlyArray<Pick<DeviceProfile, 'id' | 'name'>>,
): ConvertTarget[] {
  const unique = [...new Set(profileIds)];
  if (unique.length < 2) return [];
  const named = unique.map((id) => ({
    profileId: id,
    label: nameById(profiles, id),
  }));
  return [STRICTEST_TARGET, ...named];
}
