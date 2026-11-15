const plural = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'}`;

/** Task interval in minutes to the largest whole unit: "6 hours", "1 day", "45 minutes". */
export function formatInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '-';
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}
