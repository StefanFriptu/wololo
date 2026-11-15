import type { RuntimeConfig } from '#lib/RuntimeConfig.ts';

declare global {
  namespace App {}
  interface Window {
    __WOLOLO__?: RuntimeConfig;
  }
}
