import { statfsSync } from 'node:fs';
import { AppError } from '../../core/errors.ts';

export function requiredBytes(bytes: number, marginPercent: number): number {
  return Math.ceil(Math.max(0, bytes) * (1 + marginPercent / 100));
}

/** Bytes available to unprivileged users on dir's filesystem, or null when statfs is unavailable. */
export function availableBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const FREE_SPACE_SHORTAGE = 'free_space_shortage';

/** The error ensureFreeSpace throws; the worker treats it as transient and waits instead of failing the job. */
export function freeSpaceShortage(message: string): AppError {
  return new AppError('precondition_failed', message, { reason: FREE_SPACE_SHORTAGE });
}

export function isFreeSpaceShortage(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'precondition_failed') return false;
  const { details } = error;
  return (
    typeof details === 'object' && details !== null && 'reason' in details && details.reason === FREE_SPACE_SHORTAGE
  );
}
