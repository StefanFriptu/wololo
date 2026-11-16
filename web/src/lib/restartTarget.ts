import type { GeneralConfigView } from '#lib/shared.ts';

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

export interface RestartTarget {
  origin: string;
  urlBase: string;
}

/**
 * Where Wololo answers after a restart with the saved settings. The port only changes when the browser talks to the
 * server port directly: behind a reverse proxy the address the browser uses stays the same.
 */
export function restartTarget(
  page: URL,
  general: Pick<GeneralConfigView, 'port' | 'runningPort' | 'urlBase'>,
): RestartTarget {
  const target = new URL(page.origin);
  const pagePort = page.port || DEFAULT_PORTS[page.protocol];
  if (general.port !== general.runningPort && pagePort === String(general.runningPort))
    target.port = String(general.port);
  return { origin: target.origin, urlBase: general.urlBase };
}
