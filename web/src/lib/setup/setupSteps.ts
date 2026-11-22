import { SETUP_STEPS, type SetupStep } from '#lib/shared.ts';

export const SETUP_STEP_LABELS: Readonly<Record<SetupStep, string>> = {
  welcome: 'Welcome',
  players: 'Players',
  media: 'Media folders',
  arr: 'Sonarr / Radarr',
  plex: 'Plex',
  downloadClient: 'qBittorrent',
  imports: 'New imports',
  check: 'Check everything',
};

export const OPTIONAL_SETUP_STEPS: ReadonlySet<SetupStep> = new Set(['plex', 'downloadClient']);

export function adjacentStep(step: SetupStep, offset: -1 | 1): SetupStep | null {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + offset] ?? null;
}
