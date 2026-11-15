import type { RuntimeConfig } from '#lib/runtime.ts';

declare global {
  namespace App {}
  interface Window {
    __WOLOLO__?: RuntimeConfig;
  }
}
