import type { ApiApp } from '../../api/http.ts';
import { registerNotImplemented } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import { routesOf } from '../../shared/api-routes.ts';

export function registerIntegrationsRoutes(
  app: ApiApp,
  _ctx: AppContext,
): void {
  registerNotImplemented(app, routesOf('integrations'));
}
