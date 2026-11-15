const BY_COUNT: Readonly<Record<number, string>> = {
  1: '1.0',
  2: '2.0',
  3: '2.1',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};
const BY_LAYOUT: Readonly<Record<string, string>> = { mono: '1.0', stereo: '2.0' };

/** Speaker layout as people read it ("5.1", "7.1", "2.0"), preferring ffprobe's layout name over the count. */
export function formatChannels(channels: number | null | undefined, layout?: string | null): string {
  const named = layout ? (BY_LAYOUT[layout] ?? /^\d\.\d/.exec(layout)?.[0]) : undefined;
  if (named) return named;
  if (channels == null || channels <= 0) return '-';
  return BY_COUNT[channels] ?? `${channels}ch`;
}
