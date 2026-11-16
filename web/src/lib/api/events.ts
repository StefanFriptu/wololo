import { runtimeConfig } from '#lib/runtime.ts';
import { EVENT_NAMES, type EventMap, type EventName, type ServerEvent } from '#lib/shared.ts';
import type { EventHandler } from './EventHandler.ts';
import { reconnectDelay } from './reconnectDelay.ts';
import type { StreamStatus } from './StreamStatus.ts';
import { visibleOnly } from './visibleOnly.ts';

interface SubscribeOptions {
  apiKey: string;
  /** Only these events; omit for every event except log.entry (the server sends it only when asked). */
  names?: readonly EventName[];
  onStatus?: (status: StreamStatus) => void;
  /** Called on every "hello"; `reconnected` is true after the stream dropped, so callers can refetch. */
  onOpen?: (reconnected: boolean) => void;
}

function connect(handler: EventHandler, options: SubscribeOptions, resumed: boolean): () => void {
  const names = options.names ?? EVENT_NAMES;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let opened = resumed;
  let closed = false;

  const open = (): void => {
    const query = new URLSearchParams({ apikey: options.apiKey });
    if (options.names) query.set('events', options.names.join(','));
    const current = new EventSource(`${runtimeConfig().urlBase}/api/v1/events?${query}`);
    source = current;
    options.onStatus?.(opened ? 'reconnecting' : 'connecting');

    current.addEventListener('hello', () => {
      options.onStatus?.('open');
      options.onOpen?.(opened);
      opened = true;
      attempt = 0;
    });
    for (const name of names) {
      current.addEventListener(name, (message: MessageEvent<string>) => {
        let payload: EventMap[typeof name];
        try {
          payload = JSON.parse(message.data);
        } catch (error) {
          console.error(`[events] dropped ${name} with an unreadable payload`, error);
          return;
        }
        handler({ name, payload } as ServerEvent);
      });
    }
    current.onerror = () => {
      if (closed) return;
      options.onStatus?.('reconnecting');
      opened = true;
      if (current.readyState !== EventSource.CLOSED) return;
      current.close();
      timer = setTimeout(open, reconnectDelay(attempt));
      attempt += 1;
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}

/**
 * Subscribes to GET /api/v1/events (SSE). EventSource retries dropped connections itself; when it gives up (HTTP
 * error, server gone) a new one is opened with exponential back-off. A hidden tab closes its stream, because browsers
 * allow six HTTP/1.1 connections per origin across all tabs; it reopens as a reconnect once the tab is visible again.
 * Returns an unsubscribe function.
 */
export function subscribeEvents(handler: EventHandler, options: SubscribeOptions): () => void {
  return visibleOnly(typeof document === 'undefined' ? null : document, (resumed) =>
    connect(handler, options, resumed),
  );
}
