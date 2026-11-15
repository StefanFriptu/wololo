import { timingSafeEqual } from 'node:crypto';
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { ZodError, z } from 'zod';
import { AppError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { ApiErrorBody } from '../shared/api-types.ts';
import type { AppEnv } from './http.ts';

export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(['/api/v1/docs']);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function extractApiKey(headers: Headers, url: URL): string | null {
  const header = headers.get('x-api-key');
  if (header) return header;
  const query = url.searchParams.get('apikey') ?? url.searchParams.get('apiKey');
  if (query) return query;
  const auth = headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

/** X-Api-Key header, ?apikey= query (Radarr/Sonarr webhooks, EventSource) or Bearer token. */
export function apiKeyAuth(getApiKey: () => string, apiPrefix: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const relative = url.pathname.slice(apiPrefix.length);
    if (PUBLIC_API_PATHS.has(relative)) return next();
    const provided = extractApiKey(c.req.raw.headers, url);
    if (!provided || !safeEqual(provided, getApiKey())) {
      const body: ApiErrorBody = {
        error: 'unauthorized',
        message: 'missing or invalid API key',
      };
      return c.json(body, 401);
    }
    return next();
  };
}

export function errorHandler(log: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    if (error instanceof AppError) {
      if (error.status >= 500) {
        log.error(error.message, {
          path: c.req.path,
          code: error.code,
          details: error.details,
        });
      }
      const body: ApiErrorBody = {
        error: error.code,
        message: error.message,
        details: error.details,
      };
      return c.json(body, error.status as 400);
    }
    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: 'validation',
        message: 'validation failed',
        details: z.treeifyError(error),
      };
      return c.json(body, 400);
    }
    log.error('unhandled error', {
      path: c.req.path,
      method: c.req.method,
      error,
    });
    const body: ApiErrorBody = {
      error: 'internal',
      message: 'internal error',
    };
    return c.json(body, 500);
  };
}

export const apiNotFound: NotFoundHandler<AppEnv> = (c) => {
  const body: ApiErrorBody = {
    error: 'not_found',
    message: `no route for ${c.req.method} ${c.req.path}`,
  };
  return c.json(body, 404);
};
