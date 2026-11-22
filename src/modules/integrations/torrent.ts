import type { MediaFileStatus, TorrentInfo } from '../../shared/domain.ts';
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

export interface TorrentMediaFile {
  /** Local path of the torrent's file. */
  path: string;
  /** Shares its inode with an active recycle-bin entry of a completed audio job (it is the replaced original). */
  inRecycleBin: boolean;
  /** Local library path Radarr/Sonarr imported this file to (their history), null when not imported. */
  importedTo: string | null;
}

/**
 * A torrent may go (with its files) only when every media file has a library copy (imported, or the original an audio
 * job replaced) and at least one of them was replaced by an audio job. Anything unaccounted for keeps the torrent.
 */
export function torrentContentReplaced(
  files: readonly TorrentMediaFile[],
  replacedLibraryPaths: ReadonlySet<string>,
): boolean {
  if (files.length === 0) return false;
  let replaced = false;
  for (const file of files) {
    if (!file.inRecycleBin && file.importedTo == null) return false;
    if (file.inRecycleBin || (file.importedTo != null && replacedLibraryPaths.has(file.importedTo))) replaced = true;
  }
  return replaced;
}

/** A media file of a torrent and what Wololo knows about its library copy. */
export interface TorrentFileCopy {
  /** Local path of the torrent's file. */
  path: string;
  /** Status of its library copy; null when no library copy is known. */
  status: MediaFileStatus | null;
  /** A completed audio job replaced its library copy (by import history or by the recycle-bin hard link). */
  converted: boolean;
}

export interface TorrentConversionProgress {
  total: number;
  done: number;
  unaccounted: readonly string[];
  allConverted: boolean;
}

const NOTHING_LEFT_TO_DO: ReadonlySet<MediaFileStatus> = new Set(['compatible', 'ignored', 'blocked']);

/**
 * A torrent counts as converted when every media file has a library copy Wololo is done with (converted, or needing no
 * work it can do) and at least one was converted. A file without a known library copy keeps the torrent.
 */
export function torrentConversionProgress(files: readonly TorrentFileCopy[]): TorrentConversionProgress {
  const unaccounted = files.filter((file) => file.status == null && !file.converted).map((file) => file.path);
  const done = files.filter((file) => file.converted || (file.status != null && NOTHING_LEFT_TO_DO.has(file.status)));
  return {
    total: files.length,
    done: done.length,
    unaccounted,
    allConverted:
      files.length > 0 &&
      unaccounted.length === 0 &&
      done.length === files.length &&
      files.some((file) => file.converted),
  };
}
