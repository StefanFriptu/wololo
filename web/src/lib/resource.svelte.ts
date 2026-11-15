/**
 * Loading state for one API read: data, error and loading flag, with the previous request aborted when a new one
 * starts. `silent` reloads (live updates, polling) keep the current data on screen instead of showing a spinner.
 */
export class Resource<T> {
  data = $state.raw<T | undefined>(undefined);
  error = $state.raw<unknown>(null);
  loading = $state(false);
  #controller: AbortController | null = null;
  readonly #fetcher: (signal: AbortSignal) => Promise<T>;

  constructor(fetcher: (signal: AbortSignal) => Promise<T>) {
    this.#fetcher = fetcher;
  }

  async load(options: { silent?: boolean } = {}): Promise<void> {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    if (!options.silent) this.loading = true;
    try {
      const data = await this.#fetcher(controller.signal);
      if (controller.signal.aborted) return;
      this.data = data;
      this.error = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = error;
    } finally {
      if (this.#controller === controller) {
        this.loading = false;
        this.#controller = null;
      }
    }
  }

  set(data: T): void {
    this.data = data;
  }

  abort(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.loading = false;
  }
}
