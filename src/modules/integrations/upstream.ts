import { z } from 'zod';
import { AppError, errorMessage } from '../../core/errors.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface UpstreamRequest {
  /** Human name used in error messages ("Radarr", "Plex"). */
  service: string;
  url: string | URL;
  method?: string;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

export interface UpstreamFailure {
  status: number | null;
}

function describe(request: UpstreamRequest): string {
  const url = new URL(request.url);
  return `${request.service} ${request.method ?? 'GET'} ${url.pathname}`;
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return `rejected the credentials (HTTP ${status})`;
  return `answered HTTP ${status}`;
}

/** fetch with a timeout; network errors, timeouts and non-2xx answers become AppError('upstream'). */
export async function upstreamFetch(request: UpstreamRequest): Promise<Response> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const fetchImpl = request.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'follow',
    });
  } catch (error) {
    const reason = timeout.aborted ? `timed out after ${timeoutMs / 1000} s` : `unreachable (${errorMessage(error)})`;
    throw new AppError('upstream', `${describe(request)}: ${reason}`, { status: null } satisfies UpstreamFailure);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError('upstream', `${describe(request)}: ${statusMessage(response.status)}`, {
      status: response.status,
    } satisfies UpstreamFailure);
  }
  return response;
}

/** upstreamFetch + JSON body validated against `schema` (raw upstream shapes never leave the client). */
export async function upstreamJson<T extends z.ZodType>(request: UpstreamRequest, schema: T): Promise<z.infer<T>> {
  const response = await upstreamFetch({
    ...request,
    headers: { Accept: 'application/json', ...request.headers },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new AppError('upstream', `${describe(request)}: response is not JSON`, { status: response.status });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('upstream', `${describe(request)}: unexpected response`, {
      status: response.status,
      issues: z.treeifyError(parsed.error),
    });
  }
  return parsed.data;
}

export function upstreamStatus(error: unknown): number | null {
  if (!(error instanceof AppError) || error.code !== 'upstream') return null;
  const details = error.details as Partial<UpstreamFailure> | undefined;
  return typeof details?.status === 'number' ? details.status : null;
}
