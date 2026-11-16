import { api } from '#lib/api/client.ts';
import { restartTarget } from '#lib/restartTarget.ts';
import { runtimeConfig } from '#lib/runtime.ts';

const POLL_MS = 2000;
const GIVE_UP_MS = 120_000;
const MISSED_DOWNTIME_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok && (response.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { cache: 'no-store', mode: 'no-cors' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks Wololo to restart, waits until /health at the saved port and URL base is down and up again, then reloads
 * the page, or opens the new address when the port or URL base changed.
 * Another origin (new port) cannot be read cross-origin, so there any answer counts as up.
 */
export async function restartAndReload(): Promise<boolean> {
  const general = await api('GET /api/v1/settings/general');
  await api('POST /api/v1/system/restart');
  const target = restartTarget(new URL(location.href), general);
  const health = `${target.origin}${target.urlBase}/health`;
  const probe = target.origin === location.origin ? healthy : reachable;
  const started = Date.now();
  let wentDown = false;
  while (Date.now() - started < GIVE_UP_MS) {
    await sleep(POLL_MS);
    const up = await probe(health);
    if (!up) wentDown = true;
    if (up && (wentDown || Date.now() - started > MISSED_DOWNTIME_MS)) {
      if (target.origin === location.origin && target.urlBase === runtimeConfig().urlBase) location.reload();
      else location.assign(`${target.origin}${target.urlBase}/`);
      return true;
    }
  }
  return false;
}
