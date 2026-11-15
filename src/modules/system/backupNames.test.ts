import { expect, test } from 'bun:test';
import type { BackupInfo } from '../../shared/api-types.ts';
import { type BackupKind, formatBackupName, parseBackupKind, selectBackupsToPrune } from './backupNames.ts';

const LOCAL = new Date(2026, 10, 5, 3, 4, 9);

test.each([
  ['manual', 0, 'wololo_backup_manual_2026.11.05_03.04.09.zip'],
  ['scheduled', 0, 'wololo_backup_scheduled_2026.11.05_03.04.09.zip'],
  ['pre_restore', 2, 'wololo_backup_pre_restore_2026.11.05_03.04.09_2.zip'],
] as const)('formatBackupName - %s clash %d', (kind, clash, expected) => {
  expect(formatBackupName(kind, LOCAL, clash)).toBe(expected);
});

test.each<[string, BackupKind | null]>([
  ['wololo_backup_manual_2026.11.05_03.04.09.zip', 'manual'],
  ['wololo_backup_pre_restore_2026.11.05_03.04.09_3.zip', 'pre_restore'],
  ['wololo_backup_scheduled_2026.11.05_03.04.09.zip', 'scheduled'],
  ['wololo_backup_other_2026.11.05_03.04.09.zip', null],
  ['wololo_backup_manual_2026.11.05.zip', null],
  ['../wololo_backup_manual_2026.11.05_03.04.09.zip', null],
  ['.wololo_backup_manual_2026.11.05_03.04.09.zip.partial', null],
  ['pre-migration-2026-11-05T03-04-09-000Z.db', null],
])('parseBackupKind - %p', (name, expected) => {
  expect(parseBackupKind(name)).toBe(expected);
});

test('formatBackupName - round trips through parseBackupKind', () => {
  expect(parseBackupKind(formatBackupName('scheduled', new Date()))).toBe('scheduled');
});

function backup(kind: BackupInfo['kind'], day: number): BackupInfo {
  const createdAt = new Date(Date.UTC(2026, 0, day)).toISOString();
  return { kind, name: `${kind}-${day}`, sizeBytes: 1, createdAt };
}

test('selectBackupsToPrune - keeps the newest per kind and never prunes manual backups by default', () => {
  const backups = [
    ...Array.from({ length: 10 }, (_, index) => backup('scheduled', index + 1)),
    ...Array.from({ length: 6 }, (_, index) => backup('pre_restore', index + 1)),
    ...Array.from({ length: 20 }, (_, index) => backup('manual', index + 1)),
  ];
  expect(selectBackupsToPrune(backups).sort()).toEqual(['pre_restore-1', 'scheduled-1', 'scheduled-2']);
});

test('selectBackupsToPrune - custom limits and empty input', () => {
  const backups = [backup('manual', 1), backup('manual', 3), backup('manual', 2)];
  expect(selectBackupsToPrune(backups, { manual: 1, scheduled: null, pre_restore: null })).toEqual([
    'manual-2',
    'manual-1',
  ]);
  expect(selectBackupsToPrune([])).toEqual([]);
});
