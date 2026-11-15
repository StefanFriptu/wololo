const STEPS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

const FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "5 minutes ago", "in 2 hours", "just now"; "-" for missing or invalid timestamps. */
export function formatRelativeTime(iso: string | null | undefined, now: number): string {
  if (iso == null) return '-';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '-';
  let value = (time - now) / 1000;
  if (Math.abs(value) < 45) return 'just now';
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return FORMAT.format(Math.round(value), unit);
    value /= size;
  }
  return FORMAT.format(Math.round(value), 'year');
}
