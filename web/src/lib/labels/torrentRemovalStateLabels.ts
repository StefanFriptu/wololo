import type { TorrentRemovalState } from '#lib/shared.ts';

export const TORRENT_REMOVAL_STATE_LABELS: Readonly<Record<TorrentRemovalState, string>> = {
  pending: 'Removal pending',
  removed: 'Removed from qBittorrent',
  cancelled: 'Kept',
  missing: 'Gone from qBittorrent',
};
