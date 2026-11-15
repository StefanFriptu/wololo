import { api } from '#lib/api/client.ts';
import { runtimeConfig } from '#lib/runtime.ts';

const POLL_MS = 2000;
const GIVE_UP_MS = 120_000;
const MISSED_DOWNTIME_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${runtimeConfig().urlBase}/health`, { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

/** Asks Wololo to restart, waits until /health is down and up again, then reloads the page. */
export async function restartAndReload(): Promise<boolean> {
  await api('POST /api/v1/system/restart');
  const started = Date.now();
  let wentDown = false;
  while (Date.now() - started < GIVE_UP_MS) {
    await sleep(POLL_MS);
    const up = await healthy();
    if (!up) wentDown = true;
    if (up && (wentDown || Date.now() - started > MISSED_DOWNTIME_MS)) {
      location.reload();
      return true;
    }
  }
  return false;
}
