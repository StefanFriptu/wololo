import { runtimeConfig } from '#lib/runtime.ts';
import { resolveApiKey } from './resolveApiKey.ts';

const STORAGE_KEY = 'wololo-api-key';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(key: string | null): void {
  try {
    if (key === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // private mode: the key then lives only for this tab
  }
}

class AuthState {
  key = $state(typeof window === 'undefined' ? '' : resolveApiKey(runtimeConfig().apiKey, readStored()));
  needsKey = $derived(this.key === '');

  accept(key: string): void {
    writeStored(key);
    this.key = key;
  }

  reject(): void {
    writeStored(null);
    this.key = '';
  }
}

export const auth = new AuthState();
