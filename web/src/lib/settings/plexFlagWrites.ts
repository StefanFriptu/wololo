import type { PlexConnectionUpdate, SettingsUpdate } from '#lib/shared.ts';

/**
 * The contract stores each Plex behaviour twice (on the Plex connection and in settings) without saying which one the
 * backend reads, so one control writes both.
 */
export function plexFlagWrites(
  flag: 'partialScan' | 'pauseWhileStreaming',
  value: boolean,
): { plex: PlexConnectionUpdate; settings: SettingsUpdate } {
  if (flag === 'partialScan')
    return { plex: { partialScan: value }, settings: { notifications: { plexPartialScan: value } } };
  return { plex: { pauseWhileStreaming: value }, settings: { processing: { pauseWhilePlexStreaming: value } } };
}
