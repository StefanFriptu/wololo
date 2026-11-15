export interface RuntimeConfig {
  apiKey: string;
  urlBase: string;
  version: string;
  instanceName: string;
}

/** Injected by the backend into index.html; in `vite dev` falls back to VITE_WOLOLO_API_KEY. */
export function runtimeConfig(): RuntimeConfig {
  const injected = typeof window === 'undefined' ? undefined : window.__WOLOLO__;
  return (
    injected ?? {
      apiKey: import.meta.env.VITE_WOLOLO_API_KEY ?? '',
      urlBase: '',
      version: 'dev',
      instanceName: 'Wololo',
    }
  );
}
