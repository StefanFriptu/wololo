const FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  if (iso == null) return '-';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '-' : FORMAT.format(time);
}
