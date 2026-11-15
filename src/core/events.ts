import type { EventMap, EventName, ServerEvent } from '../shared/events.ts';

export type EventListener<K extends EventName> = (payload: EventMap[K]) => void;
export type AnyEventListener = (event: ServerEvent) => void;

/** Synchronous, typed, in-process pub/sub. Listener errors are reported via onError and never reach the emitter. */
export class EventBus {
  private readonly listeners = new Map<
    EventName,
    Set<EventListener<EventName>>
  >();
  private readonly anyListeners = new Set<AnyEventListener>();

  constructor(
    private readonly onError: (
      error: unknown,
      event: EventName,
    ) => void = () => {},
  ) {}

  on<K extends EventName>(name: K, listener: EventListener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as EventListener<EventName>);
    return () => set.delete(listener as EventListener<EventName>);
  }

  onAny(listener: AnyEventListener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  emit<K extends EventName>(name: K, payload: EventMap[K]): void {
    for (const listener of this.listeners.get(name) ?? [])
      this.call(() => listener(payload), name);
    const event = { name, payload } as ServerEvent;
    for (const listener of this.anyListeners)
      this.call(() => listener(event), name);
  }

  listenerCount(): number {
    let count = this.anyListeners.size;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  private call(fn: () => void, name: EventName): void {
    try {
      fn();
    } catch (error) {
      this.onError(error, name);
    }
  }
}
