import { createSubscriber } from 'svelte/reactivity';

const TICK_MS = 30_000;

export class Clock {
  readonly #subscribe: () => void;

  constructor(tickMs: number) {
    this.#subscribe = createSubscriber((update) => {
      const timer = setInterval(update, tickMs);
      return () => clearInterval(timer);
    });
  }

  get now(): number {
    this.#subscribe();
    return Date.now();
  }
}

export const clock = new Clock(TICK_MS);
