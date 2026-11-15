import { runtimeConfig } from '#lib/runtime.ts';
import {
  API_ROUTE_META,
  type ApiErrorBody,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  splitRouteKey,
} from '#lib/shared.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ParamsOption<K extends RouteKey> =
  RouteParams<K> extends undefined
    ? { params?: never }
    : { params: RouteParams<K> };
type QueryOption<K extends RouteKey> =
  RouteQuery<K> extends undefined
    ? { query?: never }
    : { query?: RouteQuery<K> };
type BodyOption<K extends RouteKey> =
  RouteBody<K> extends undefined ? { body?: never } : { body: RouteBody<K> };

export type RequestOptions<K extends RouteKey> = ParamsOption<K> &
  QueryOption<K> &
  BodyOption<K> & { signal?: AbortSignal };

type RequiredKeys<T> = {
  [P in keyof T]-?: undefined extends T[P] ? never : P;
}[keyof T];
type OptionsArgs<K extends RouteKey> =
  RequiredKeys<RequestOptions<K>> extends never
    ? [options?: RequestOptions<K>]
    : [options: RequestOptions<K>];

export function buildPath(
  path: string,
  params?: Record<string, string | number>,
): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
}

export function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Typed call against the shared route map: api('GET /api/v1/jobs/:id', { params: { id: 1 } }). */
export async function api<K extends RouteKey>(
  key: K,
  ...args: OptionsArgs<K>
): Promise<RouteResponse<K>> {
  const options = (args[0] ?? {}) as {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
  };
  const { method, path } = splitRouteKey(key);
  const config = runtimeConfig();
  const url = `${config.urlBase}${buildPath(path, options.params)}${buildQuery(options.query)}`;
  const headers: Record<string, string> = {
    'X-Api-Key': config.apiKey,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    const error = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'http_error',
      error?.message ?? `${method} ${path} failed with ${response.status}`,
      error?.details,
    );
  }

  switch (API_ROUTE_META[key].responseType) {
    case 'empty':
      return undefined as RouteResponse<K>;
    case 'text':
    case 'html':
      return (await response.text()) as RouteResponse<K>;
    case 'blob':
      return (await response.blob()) as RouteResponse<K>;
    default:
      return (await response.json()) as RouteResponse<K>;
  }
}
