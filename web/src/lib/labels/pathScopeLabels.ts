import type { PathMappingScope } from '#lib/shared.ts';

export const PATH_SCOPE_LABELS: Readonly<Record<PathMappingScope, string>> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  plex: 'Plex',
  qbittorrent: 'qBittorrent',
};
