const STORAGE_KEY = 'wololo-webhook-address';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]']);

type AddressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The address saved in this browser, else the browser's origin. Storage may throw (private mode, blocked). */
export function loadWebhookAddress(storage: () => AddressStorage, origin: string): string {
  try {
    return storage().getItem(STORAGE_KEY) || origin;
  } catch {
    return origin;
  }
}

/** Forgets the address when it is empty or the browser's origin, so the default follows the browser. */
export function saveWebhookAddress(storage: () => AddressStorage, address: string, origin: string): void {
  const value = address.trim().replace(/\/+$/, '');
  try {
    if (!value || value === origin) storage().removeItem(STORAGE_KEY);
    else storage().setItem(STORAGE_KEY, value);
  } catch {
    // storage blocked: the address then lives only for this page
  }
}

/** Radarr and Sonarr in other containers cannot reach the browser's localhost. */
export function isLoopbackAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname;
    return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
  } catch {
    return false;
  }
}
