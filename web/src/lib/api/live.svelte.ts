import type { ServerEvent } from '#lib/shared.ts';
import type { EventHandler } from './EventHandler.ts';
import { subscribeEvents } from './events.ts';
import type { StreamStatus } from './StreamStatus.ts';

class LiveEvents {
  status = $state<StreamStatus>('connecting');
  #handlers = new Set<EventHandler>();
  #reconnectHandlers = new Set<() => void>();

  connect(apiKey: string): () => void {
    return subscribeEvents((event) => this.#dispatch(event), {
      apiKey,
      onStatus: (status) => {
        this.status = status;
      },
      onOpen: (reconnected) => {
        if (!reconnected) return;
        for (const handler of this.#reconnectHandlers) handler();
      },
    });
  }

  on(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onReconnect(handler: () => void): () => void {
    this.#reconnectHandlers.add(handler);
    return () => this.#reconnectHandlers.delete(handler);
  }

  #dispatch(event: ServerEvent): void {
    for (const handler of this.#handlers) handler(event);
  }
}

export const live = new LiveEvents();
