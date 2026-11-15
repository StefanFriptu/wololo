export function formatSpeed(speed: number | null | undefined): string {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return '-';
  return `${speed.toFixed(1)}x`;
}
