import { type MediaTorrent, TORRENT_REMOVAL_CONDITIONS, type TorrentRemovalCondition } from '#lib/shared.ts';

export type RemovalChoice = 'keep' | TorrentRemovalCondition;

export const REMOVAL_CHOICES: readonly RemovalChoice[] = ['keep', ...TORRENT_REMOVAL_CONDITIONS];

export type RemovalChange = { kind: 'request'; condition: TorrentRemovalCondition } | { kind: 'cancel' };

function pendingCondition(torrent: MediaTorrent | null): TorrentRemovalCondition | null {
  return torrent?.removal?.state === 'pending' ? torrent.removal.condition : null;
}

/** The dialog starts on the pending request, if any, else on keeping the torrent. */
export function initialRemovalChoice(torrent: MediaTorrent | null): RemovalChoice {
  return pendingCondition(torrent) ?? 'keep';
}

/** The API call a choice needs; null when it matches what is already stored. */
export function removalChange(torrent: MediaTorrent | null, choice: RemovalChoice): RemovalChange | null {
  if (!torrent) return null;
  const pending = pendingCondition(torrent);
  if (choice === 'keep') return pending ? { kind: 'cancel' } : null;
  return choice === pending ? null : { kind: 'request', condition: choice };
}

export function torrentProgress(torrent: MediaTorrent): string {
  const progress = `${torrent.done} of ${torrent.total} file${torrent.total === 1 ? '' : 's'} converted`;
  return torrent.unaccounted.length > 0 ? `${progress}, ${torrent.unaccounted.length} not in your library` : progress;
}
