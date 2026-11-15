import { runtimeConfig } from '#lib/runtime.ts';
import {
  EVENT_NAMES,
  type EventMap,
  type EventName,
  type ServerEvent,
} from '#lib/shared.ts';

export type EventHandler = (event: ServerEvent) => void;

/** Subscribes to GET /api/v1/events (SSE). EventSource reconnects on its own; returns an unsubscribe function. */
export function subscribeEvents(
  handler: EventHandler,
  names: readonly EventName[] = EVENT_NAMES,
): () => void {
  const config = runtimeConfig();
  const query = new URLSearchParams({ apikey: config.apiKey });
  if (names !== EVENT_NAMES) query.set('events', names.join(','));
  const source = new EventSource(`${config.urlBase}/api/v1/events?${query}`);
  const listeners = names.map((name) => {
    const listener = (message: MessageEvent<string>) => {
      handler({
        name,
        payload: JSON.parse(message.data) as EventMap[typeof name],
      } as ServerEvent);
    };
    source.addEventListener(name, listener);
    return [name, listener] as const;
  });
  return () => {
    for (const [name, listener] of listeners)
      source.removeEventListener(name, listener);
    source.close();
  };
}
