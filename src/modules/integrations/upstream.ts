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

export interface UpstreamText {
  response: Response;
  text: string;
}

interface Sent {
  response: Response;
  fail: (error: unknown, phase: 'request' | 'body') => AppError;
}

const UNTRUSTED_CERT_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function untrustedCertHint(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : null;
  return typeof code === 'string' && UNTRUSTED_CERT_CODES.has(code)
    ? '; to trust a self-signed or private CA certificate, set NODE_EXTRA_CA_CERTS (see README)'
    : '';
}

function describe(request: UpstreamRequest): string {
  const url = new URL(request.url);
  return `${request.service} ${request.method ?? 'GET'} ${url.pathname}`;
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return `rejected the credentials (HTTP ${status})`;
  return `answered HTTP ${status}`;
}

function redirectTarget(response: Response, request: UpstreamRequest): string {
  const location = response.headers.get('location');
  if (!location) return 'another address';
  try {
    return new URL(location, request.url).host;
  } catch {
    return 'another address';
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Redirects are refused, not followed: fetch would forward X-Api-Key, X-Plex-Token and the qBittorrent cookie to the
 * redirect target, and none of these APIs needs one.
 */
async function send(request: UpstreamRequest): Promise<Sent> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const fetchImpl = request.fetch ?? fetch;
  const fail = (error: unknown, phase: 'request' | 'body') => {
    const lost = phase === 'request' ? 'unreachable' : 'response interrupted';
    const reason = timeout.aborted
      ? `timed out after ${timeoutMs / 1000} s`
      : `${lost} (${errorMessage(error)})${untrustedCertHint(error)}`;
    return new AppError('upstream', `${describe(request)}: ${reason}`, { status: null } satisfies UpstreamFailure);
  };
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'manual',
    });
  } catch (error) {
    throw fail(error, 'request');
  }
  if (response.status >= 300 && response.status < 400) {
    const target = redirectTarget(response, request);
    await discard(response);
    throw new AppError('upstream', `${describe(request)}: redirected to ${target}; enter the final URL instead`, {
      status: response.status,
    } satisfies UpstreamFailure);
  }
  if (!response.ok) {
    await discard(response);
    throw new AppError('upstream', `${describe(request)}: ${statusMessage(response.status)}`, {
      status: response.status,
    } satisfies UpstreamFailure);
  }
  return { response, fail };
}

/** fetch with a timeout; network errors, timeouts, redirects and non-2xx answers become AppError('upstream'). */
export async function upstreamFetch(request: UpstreamRequest): Promise<Response> {
  const { response } = await send(request);
  await discard(response);
  return response;
}

/** upstreamFetch + the whole body as text, read under the same timeout (a stalled body is AppError('upstream')). */
export async function upstreamText(request: UpstreamRequest): Promise<UpstreamText> {
  const { response, fail } = await send(request);
  try {
    return { response, text: await response.text() };
  } catch (error) {
    throw fail(error, 'body');
  }
}

/** upstreamText + JSON body validated against `schema` (raw upstream shapes never leave the client). */
export async function upstreamJson<T extends z.ZodType>(request: UpstreamRequest, schema: T): Promise<z.infer<T>> {
  const { response, text } = await upstreamText({
    ...request,
    headers: { Accept: 'application/json', ...request.headers },
  });
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

/** Network errors, timeouts, 429 and 5xx: worth another attempt later. Bad credentials, URLs or answers are not. */
export function isTransientUpstreamError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'upstream') return false;
  const status = (error.details as Partial<UpstreamFailure> | undefined)?.status;
  if (status === null) return true;
  return typeof status === 'number' && (status === 429 || status >= 500);
}
