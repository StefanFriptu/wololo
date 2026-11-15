/** 0..1 fraction to a whole percent, rounded down so 99.9% never reads as done. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return '-';
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${Math.floor(clamped * 100)}%`;
}
