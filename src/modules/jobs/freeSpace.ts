import { statfsSync } from 'node:fs';

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
