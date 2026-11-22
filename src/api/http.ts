import type { Server } from 'bun';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../core/errors.ts';
import { splitRouteKey } from '../shared/api-routes.ts';
import type { RouteKey, RouteResponse } from '../shared/api-types.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../shared/paging.ts';

/** server is passed by Bun.serve (`fetch: (req, server) => app.fetch(req, { server })`); absent in app.request() tests. */
export interface AppBindings {
  server?: Server<undefined>;
}
export type AppEnv = { Bindings: AppBindings };
export type ApiApp = Hono<AppEnv>;
export type ApiContext = Context<AppEnv>;

type MaybePromise<T> = T | Promise<T>;
export type RouteHandler<K extends RouteKey> = (c: ApiContext) => MaybePromise<RouteResponse<K> | Response>;

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type Method = (typeof METHODS)[number];

/** Zod schemas a handler validates with; recorded for the OpenAPI document (system.openApiDocument). */
export interface RouteSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

const ROUTE_SCHEMAS = new Map<RouteKey, RouteSchemas>();

export function routeSchemas(): ReadonlyMap<RouteKey, RouteSchemas> {
  return ROUTE_SCHEMAS;
}

/** Remote address of the request when served by Bun.serve; null under app.request(). */
export function requestIp(c: ApiContext): string | null {
  const server = (c.env as AppBindings | undefined)?.server;
  return server?.requestIP(c.req.raw)?.address ?? null;
}

/**
 * Registers a handler for a route of the shared ApiRoutes map. The return value is type-checked against
 * the contract and serialised as JSON; undefined becomes 204 No Content; a Response (text/blob/sse) passes through.
 * Pass the zod schemas the handler parses with, so the OpenAPI document can describe them.
 */
export function route<K extends RouteKey>(app: ApiApp, key: K, handler: RouteHandler<K>, schemas?: RouteSchemas): void {
  const { method, path } = splitRouteKey(key);
  if (!METHODS.includes(method as Method)) throw new Error(`unsupported method in route key ${key}`);
  if (schemas) ROUTE_SCHEMAS.set(key, schemas);
  app.on(method, path, async (c) => {
    const result = await handler(c);
    if (result instanceof Response) return result;
    if (result === undefined) return c.body(null, 204);
    return c.json(result as never);
  });
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('validation', `invalid ${where}`, z.treeifyError(parsed.error));
  return parsed.data;
}

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function parseParams<T extends z.ZodType>(c: ApiContext, schema: T): z.infer<T> {
  return parseWith(schema, c.req.param(), 'path parameters');
}

export function parseId(c: ApiContext): number {
  return parseParams(c, idParamSchema).id;
}

/** Query strings arrive as strings: use z.coerce for numbers and booleans. */
export function parseQuery<T extends z.ZodType>(c: ApiContext, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query(), 'query');
}

export async function parseBody<T extends z.ZodType>(c: ApiContext, schema: T): Promise<z.infer<T>> {
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
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortDir: z.enum(['asc', 'desc']).optional(),
});
