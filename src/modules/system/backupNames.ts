import type { BackupInfo } from '../../shared/api-types.ts';

export type BackupKind = BackupInfo['kind'];

const NAME_PATTERN =
  /^wololo_backup_(manual|scheduled|pre_restore)_(\d{4}\.\d{2}\.\d{2}_\d{2}\.\d{2}\.\d{2})(?:_(\d+))?\.zip$/;

/** How many backups of each kind survive pruning; null keeps all (manual backups are only deleted by the user). */
export const BACKUPS_KEPT: Readonly<Record<BackupKind, number | null>> = {
  manual: null,
  scheduled: 8,
  pre_restore: 5,
};

const pad = (value: number) => String(value).padStart(2, '0');

/** Pure: "wololo_backup_<kind>_<yyyy.MM.dd_HH.mm.ss>.zip" in local time (the container's TZ), "_<n>" on a clash. */
export function formatBackupName(kind: BackupKind, date: Date, clash = 0): string {
  const stamp =
    `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}_` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `wololo_backup_${kind}_${stamp}${clash > 0 ? `_${clash}` : ''}.zip`;
}

/** Pure: the kind of a backup file name, null for anything that is not a Wololo backup name. */
export function parseBackupKind(name: string): BackupKind | null {
  const kind = NAME_PATTERN.exec(name)?.[1];
  return kind === 'manual' || kind === 'scheduled' || kind === 'pre_restore' ? kind : null;
}

/** Pure: names of backups beyond the per-kind limit, oldest first out. */
export function selectBackupsToPrune(
  backups: readonly BackupInfo[],
  kept: Readonly<Record<BackupKind, number | null>> = BACKUPS_KEPT,
): string[] {
  const newestFirst = [...backups].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name),
  );
  const seen: Record<BackupKind, number> = { manual: 0, scheduled: 0, pre_restore: 0 };
  return newestFirst
    .filter((backup) => {
      seen[backup.kind] += 1;
      const limit = kept[backup.kind];
      return limit !== null && seen[backup.kind] > limit;
    })
    .map((backup) => backup.name);
}
