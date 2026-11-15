import type { PlexSessions } from '../../shared/api-types.ts';
import type { PlexSection, PlexServer } from '../../shared/domain.ts';
import { isSameOrInside } from './path-map.ts';

/** The section whose Location contains the path; the deepest Location wins when libraries are nested. */
export function findSectionForPath(
  sections: readonly PlexSection[],
  plexPath: string,
): { section: PlexSection; location: string } | null {
  let best: { section: PlexSection; location: string } | null = null;
  for (const section of sections) {
    for (const location of section.locations) {
      if (!isSameOrInside(plexPath, location)) continue;
      if (!best || location.length > best.location.length) best = { section, location };
    }
  }
  return best;
}

/** Local direct connection first, then a remote direct one, relay last (Wololo usually shares the server's LAN). */
export function pickConnection(connections: PlexServer['connections']): PlexServer['connections'][number] | null {
  const rank = (connection: PlexServer['connections'][number]) => (connection.relay ? 2 : connection.local ? 0 : 1);
  return [...connections].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export function toSession(raw: {
  title?: string | null;
  grandparentTitle?: string | null;
  User?: { title?: string | null } | null;
  Player?: { state?: string | null } | null;
  TranscodeSession?: { videoDecision?: string | null; audioDecision?: string | null } | null;
}): PlexSessions['sessions'][number] {
  const title = raw.grandparentTitle ? `${raw.grandparentTitle} - ${raw.title ?? ''}` : (raw.title ?? 'unknown');
  const transcode = raw.TranscodeSession;
  return {
    title,
    user: raw.User?.title ?? null,
    state: raw.Player?.state ?? 'unknown',
    transcoding:
      transcode != null && (transcode.videoDecision === 'transcode' || transcode.audioDecision === 'transcode'),
  };
}
