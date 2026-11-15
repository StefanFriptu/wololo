import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../core/errors.ts';
import { API_ROUTE_META, splitRouteKey } from '../shared/api-routes.ts';
import type { RouteKey, RouteResponse } from '../shared/api-types.ts';

export type AppEnv = Record<string, never>;
export type ApiApp = Hono<AppEnv>;
export type ApiContext = Context<AppEnv>;

type MaybePromise<T> = T | Promise<T>;
export type RouteHandler<K extends RouteKey> = (
  c: ApiContext,
) => MaybePromise<RouteResponse<K> | Response>;

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type Method = (typeof METHODS)[number];

/**
 * Registers a handler for a route of the shared ApiRoutes map. The return value is type-checked against
 * the contract and serialised as JSON; undefined becomes 204 No Content; a Response (text/blob/sse) passes through.
 */
export function route<K extends RouteKey>(
  app: ApiApp,
  key: K,
  handler: RouteHandler<K>,
): void {
  const { method, path } = splitRouteKey(key);
  if (!METHODS.includes(method as Method))
    throw new Error(`unsupported method in route key ${key}`);
  app.on(method, path, async (c) => {
    const result = await handler(c);
    if (result instanceof Response) return result;
    if (result === undefined) return c.body(null, 204);
    return c.json(result as never);
  });
}

/** Registers a 501 handler for each key not implemented yet. Register real handlers first: the first match wins. */
export function registerNotImplemented(
  app: ApiApp,
  keys: readonly RouteKey[],
): void {
  for (const key of keys) {
    const { method, path } = splitRouteKey(key);
    app.on(method, path, (c) =>
      c.json(
        {
          error: 'not_implemented',
          message: `${key} is not implemented yet (${API_ROUTE_META[key].module})`,
        },
        501,
      ),
    );
  }
}

function parseWith<T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      'validation',
      `invalid ${where}`,
      z.treeifyError(parsed.error),
    );
  return parsed.data;
}

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function parseParams<T extends z.ZodType>(
  c: ApiContext,
  schema: T,
): z.infer<T> {
  return parseWith(schema, c.req.param(), 'path parameters');
}

export function parseId(c: ApiContext): number {
  return parseParams(c, idParamSchema).id;
}

/** Query strings arrive as strings: use z.coerce for numbers and booleans. */
export function parseQuery<T extends z.ZodType>(
  c: ApiContext,
  schema: T,
): z.infer<T> {
  return parseWith(schema, c.req.query(), 'query');
}

export async function parseBody<T extends z.ZodType>(
  c: ApiContext,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError('validation', 'request body is not valid JSON');
  }
  return parseWith(schema, body, 'body');
}

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
