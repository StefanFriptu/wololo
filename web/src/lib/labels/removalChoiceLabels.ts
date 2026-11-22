import type { RemovalChoice } from '#lib/library/torrentRemoval.ts';

export const REMOVAL_CHOICE_LABELS: Readonly<Record<RemovalChoice, string>> = {
  keep: 'Keep the torrent',
  converted: 'Remove it once all its files are converted',
  converted_and_seeded: 'Remove it once all its files are converted and its seeding goal is met',
};
