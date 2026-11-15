import type { LogLevel } from '#lib/shared.ts';
import type { Tone } from './Tone.ts';

export const LOG_LEVEL_TONES: Readonly<Record<LogLevel, Tone>> = {
  trace: 'neutral',
  debug: 'neutral',
  info: 'info',
  warn: 'warning',
  error: 'danger',
};
