import type { ServerEvent } from '#lib/shared.ts';

export type EventHandler = (event: ServerEvent) => void;
