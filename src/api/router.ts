import type { AppContext } from '../app/context.ts';
import { registerBdmvRoutes } from '../modules/bdmv/routes.ts';
import { registerIntegrationsRoutes } from '../modules/integrations/routes.ts';
import { registerJobsRoutes } from '../modules/jobs/routes.ts';
import { registerRulesFfmpegRoutes } from '../modules/profiles/routes.ts';
import { registerProbeScanRoutes } from '../modules/scan/routes.ts';
import { registerPlatformRoutes } from '../modules/system/routes.ts';
import { registerCoreRoutes } from './core-routes.ts';
import type { ApiApp } from './http.ts';

/** One registration function per module key; each module owns its routes.ts. */
export function registerApiRoutes(app: ApiApp, ctx: AppContext): void {
  registerCoreRoutes(app, ctx);
  registerProbeScanRoutes(app, ctx);
  registerRulesFfmpegRoutes(app, ctx);
  registerJobsRoutes(app, ctx);
  registerIntegrationsRoutes(app, ctx);
  registerBdmvRoutes(app, ctx);
  registerPlatformRoutes(app, ctx);
}
