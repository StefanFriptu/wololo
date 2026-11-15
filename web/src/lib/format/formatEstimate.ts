/** Coarse duration for estimates, two largest units: "2d 3h", "3h 20m", "12m", "< 1m". */
export function formatEstimate(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '-';
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes === 0) return seconds > 0 ? '< 1m' : '0m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}
