/** Lets timers, I/O and HTTP handlers run between slices of a long loop over synchronous SQLite calls. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
