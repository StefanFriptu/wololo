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
import { ApiError } from './ApiError.ts';
import { auth } from './auth.svelte.ts';
import { buildPath } from './buildPath.ts';
import { buildQuery } from './buildQuery.ts';

type ParamsOption<K extends RouteKey> =
  RouteParams<K> extends undefined ? { params?: never } : { params: RouteParams<K> };
type QueryOption<K extends RouteKey> = RouteQuery<K> extends undefined ? { query?: never } : { query?: RouteQuery<K> };
type BodyOption<K extends RouteKey> = RouteBody<K> extends undefined ? { body?: never } : { body: RouteBody<K> };

type RequestOptions<K extends RouteKey> = ParamsOption<K> &
  QueryOption<K> &
  BodyOption<K> & { signal?: AbortSignal; apiKey?: string };

type RequiredKeys<T> = {
  [P in keyof T]-?: undefined extends T[P] ? never : P;
}[keyof T];
type OptionsArgs<K extends RouteKey> =
  RequiredKeys<RequestOptions<K>> extends never ? [options?: RequestOptions<K>] : [options: RequestOptions<K>];

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, 'network', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Typed call against the shared route map: api('GET /api/v1/jobs/:id', { params: { id: 1 } }).
 * A 401 forgets the stored key so the layout shows the API key prompt; `apiKey` overrides the key for one call.
 */
export async function api<K extends RouteKey>(key: K, ...args: OptionsArgs<K>): Promise<RouteResponse<K>> {
  const options = (args[0] ?? {}) as {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
    apiKey?: string;
  };
  const { method, path } = splitRouteKey(key);
  const url = `${runtimeConfig().urlBase}${buildPath(path, options.params)}${buildQuery(options.query)}`;
  const headers: Record<string, string> = {
    'X-Api-Key': options.apiKey ?? auth.key,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await send(url, { method, headers, body, signal: options.signal });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401 && options.apiKey === undefined) auth.reject();
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
