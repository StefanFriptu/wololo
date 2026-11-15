import { basename } from 'node:path';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from '../app/context.ts';
import { isValidBindAddress, isValidUrlBase } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import type { GeneralConfigView } from '../shared/api-types.ts';
import type { ServerEvent, StreamHello } from '../shared/events.ts';
import { AUTHENTICATION_MODES, type GeneralConfig } from '../shared/settings.ts';
import { type ApiApp, parseBody, parseQuery, route } from './http.ts';

const SSE_HEARTBEAT_MS = 25_000;

const generalUpdateSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    bindAddress: z.string().refine(isValidBindAddress, 'expected "*" or an IP address'),
    urlBase: z.string().refine(isValidUrlBase, 'expected "" or "/path" with letters, digits, ".", "_", "~", "-"'),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
    instanceName: z.string().trim().min(1).max(64),
    authentication: z.enum(AUTHENTICATION_MODES),
  })
  .partial();

/** Deep-partial patch; the merged result is validated in full by SettingsStore.update. */
const settingsUpdateSchema = z.record(z.string(), z.unknown());

const logQuerySchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
  module: z.string().optional(),
  afterId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const RESTART_KEYS: (keyof GeneralConfig)[] = ['port', 'bindAddress', 'urlBase'];

export function registerCoreRoutes(app: ApiApp, ctx: AppContext): void {
  const bootConfig = ctx.config.get();
  const generalView = (): GeneralConfigView => {
    const config = ctx.config.get();
    return {
      port: config.port,
      bindAddress: config.bindAddress,
      urlBase: config.urlBase,
      apiKey: config.apiKey,
      logLevel: config.logLevel,
      instanceName: config.instanceName,
      authentication: config.authentication,
      restartRequired: RESTART_KEYS.some((key) => config[key] !== bootConfig[key]),
      envOverrides: [...config.envOverrides],
    };
  };

  route(app, 'GET /health', () => ({
    status: 'ok',
    version: ctx.config.get().version,
  }));

  route(app, 'GET /api/v1/events', (c) => {
    const filter = new Set((c.req.query('events') ?? '').split(',').filter(Boolean));
    const includeLogs = filter.has('log.entry');
    return streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = ctx.events.onAny((event) => {
        if (event.name === 'log.entry' && !includeLogs) return;
        if (filter.size > 0 && !filter.has(event.name)) return;
        queue.push(event);
        wake?.();
      });
      const heartbeat = setInterval(() => wake?.(), SSE_HEARTBEAT_MS);
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        wake?.();
      });
      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ version: ctx.config.get().version } satisfies StreamHello),
      });
      while (!stream.aborted && !ctx.shutdownSignal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          if (queue.length === 0 && !stream.aborted) await stream.write(': ping\n\n');
          continue;
        }
        const event = queue.shift() as ServerEvent;
        await stream.writeSSE({
          event: event.name,
          data: JSON.stringify(event.payload),
        });
      }
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  route(app, 'GET /api/v1/settings', () => ctx.settings.get());
  route(app, 'PUT /api/v1/settings', async (c) => ctx.settings.update(await parseBody(c, settingsUpdateSchema)), {
    body: settingsUpdateSchema,
  });

  route(app, 'GET /api/v1/settings/general', () => generalView());
  route(
    app,
    'PUT /api/v1/settings/general',
    async (c) => {
      const patch = await parseBody(c, generalUpdateSchema);
      const locked = (Object.keys(patch) as (keyof GeneralConfig)[]).filter((key) =>
        ctx.config.get().envOverrides.includes(key),
      );
      if (locked.length > 0) throw new AppError('conflict', `set by environment variables: ${locked.join(', ')}`);
      const next = ctx.config.update(patch);
      ctx.logs.setLevel(next.logLevel);
      return generalView();
    },
    { body: generalUpdateSchema },
  );
  route(app, 'POST /api/v1/settings/general/apikey', () => {
    if (ctx.config.get().envOverrides.includes('apiKey')) {
      throw new AppError('conflict', 'API key is set by WOLOLO__API_KEY');
    }
    ctx.config.regenerateApiKey();
    ctx.log.info('API key regenerated');
    return generalView();
  });

  route(app, 'GET /api/v1/system/logs', (c) => ctx.logs.entries(parseQuery(c, logQuerySchema)), {
    query: logQuerySchema,
  });
  route(app, 'GET /api/v1/system/logs/files', () =>
    ctx.logs.listFiles().map(({ name, sizeBytes, modifiedAt }) => ({
      name,
      sizeBytes,
      modifiedAt,
    })),
  );
  route(app, 'GET /api/v1/system/logs/files/:name', (c) => {
    const name = basename(c.req.param('name') ?? '');
    const file = ctx.logs.listFiles().find((entry) => entry.name === name);
    if (!file) throw new AppError('not_found', 'log file not found');
    ctx.logs.flush();
    return new Response(Bun.file(file.path), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `inline; filename="${name}"`,
      },
    });
  });
}
