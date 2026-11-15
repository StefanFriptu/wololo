import type { Server } from 'bun';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

export type FakeHandler = (request: RecordedRequest) => Response | unknown | Promise<Response | unknown>;

export interface FakeUpstream {
  url: string;
  requests: RecordedRequest[];
  /** Replaces or adds the handler for "METHOD /path" (query string ignored). */
  on(key: string, handler: FakeHandler): void;
  requestsTo(key: string): RecordedRequest[];
  stop(): void;
}

/** Local HTTP fake for upstream APIs (tests only): Bun.serve on port 0, records every request, 404 for unknown routes. */
export function startFakeUpstream(routes: Record<string, FakeHandler> = {}): FakeUpstream {
  const handlers = new Map(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (raw) => {
      const url = new URL(raw.url);
      const recorded: RecordedRequest = {
        method: raw.method,
        path: url.pathname,
        query: url.searchParams,
        headers: raw.headers,
        body: await raw.text(),
      };
      requests.push(recorded);
      const handler = handlers.get(`${raw.method} ${url.pathname}`);
      if (!handler) return new Response('not found', { status: 404 });
      const result = await handler(recorded);
      return result instanceof Response ? result : Response.json(result);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    on: (key, handler) => {
      handlers.set(key, handler);
    },
    requestsTo: (key) => requests.filter((request) => `${request.method} ${request.path}` === key),
    stop: () => {
      server.stop(true);
    },
  };
}
