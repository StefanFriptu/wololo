import { Hono } from 'hono';
import type { AppEnv } from '../api/http.ts';
import { apiKeyAuth, apiNotFound, errorHandler, securityHeaders } from '../api/middleware.ts';
import { registerApiRoutes } from '../api/router.ts';
import { spaHandler } from '../api/static.ts';
import type { AppContext } from './context.ts';

/** Builds the Hono app: auth on /api/*, all module routes, SPA with fallback, everything under the URL base. */
export function createHttpApp(ctx: AppContext): Hono<AppEnv> {
  const config = ctx.config.get();
  const urlBase = config.urlBase;
  const onError = errorHandler(ctx.logs.logger('http'));

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', securityHeaders);
  app.use(
    '/api/*',
    apiKeyAuth(() => ctx.config.get().apiKey, urlBase),
  );
  registerApiRoutes(app, ctx);
  app.all('/api/*', apiNotFound);
  app.use(
    '*',
    spaHandler({
      webDir: config.webDir,
      urlBase,
      runtimeConfig: () => {
        const current = ctx.config.get();
        return {
          apiKey: current.apiKey,
          urlBase,
          version: current.version,
          instanceName: current.instanceName,
        };
      },
      authentication: () => ctx.config.get().authentication,
    }),
  );

  if (!urlBase) return app;
  const root = new Hono<AppEnv>();
  root.onError(onError);
  root.use('*', securityHeaders);
  root.get('/', (c) => c.redirect(`${urlBase}/`));
  root.route(urlBase, app);
  return root;
}
