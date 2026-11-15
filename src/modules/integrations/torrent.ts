import type { TorrentInfo } from '../../shared/domain.ts';
import { isSameOrInside, joinRemotePath } from './path-map.ts';
import type { RawTorrent } from './qbittorrent-client.ts';

const SEEDING_STATES: ReadonlySet<string> = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP']);

/** qBittorrent limits: max_* is the effective value (global resolved), *_limit the per-torrent one; < 0 means none. */
function effectiveLimit(effective: number | null | undefined, own: number | null | undefined): number | null {
  if (effective != null) return effective >= 0 ? effective : null;
  return own != null && own >= 0 ? own : null;
}

export function toTorrentInfo(raw: RawTorrent): TorrentInfo {
  const ratioLimit = effectiveLimit(raw.max_ratio, raw.ratio_limit);
  const timeLimitMin = effectiveLimit(raw.max_seeding_time, raw.seeding_time_limit);
  const seedingTimeLimitSec = timeLimitMin == null ? null : timeLimitMin * 60;
  const seedingTimeSec = raw.seeding_time ?? 0;
  const complete = raw.progress >= 1;
  const goalMet =
    complete &&
    ((ratioLimit != null && raw.ratio >= ratioLimit) ||
      (seedingTimeLimitSec != null && seedingTimeSec >= seedingTimeLimitSec));
  return {
    hash: raw.hash,
    name: raw.name,
    savePath: raw.save_path,
    contentPath: raw.content_path || joinRemotePath(raw.save_path, raw.name),
    state: raw.state,
    seeding: SEEDING_STATES.has(raw.state),
    ratio: raw.ratio,
    seedingTimeSec,
    ratioLimit,
    seedingTimeLimitSec,
    goalMet,
  };
}

/**
 * The torrent owning a path (qBittorrent's view): exact content path first, then the torrent whose content folder
 * contains the path (deepest wins), then a torrent stored inside the given folder.
 */
export function matchTorrent(torrents: readonly TorrentInfo[], path: string): TorrentInfo | null {
  const exact = torrents.find((torrent) => torrent.contentPath === path);
  if (exact) return exact;
  const containing = torrents
    .filter((torrent) => isSameOrInside(path, torrent.contentPath))
    .sort((a, b) => b.contentPath.length - a.contentPath.length)[0];
  if (containing) return containing;
  return torrents.find((torrent) => isSameOrInside(torrent.contentPath, path)) ?? null;
}
