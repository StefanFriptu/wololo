import { type ApiApp, idParamSchema, parseBody, parseId, parseParams, parseQuery, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import {
  DryRunQuerySchema,
  FilesystemQuerySchema,
  LibraryInputSchema,
  MediaIgnoreBodySchema,
  MediaQuerySchema,
  MediaStatsQuerySchema,
  ScanRequestSchema,
  TaskParamsSchema,
  TaskUpdateSchema,
} from './schemas.ts';

export function registerProbeScanRoutes(app: ApiApp, ctx: AppContext): void {
  const { services } = ctx;

  route(app, 'GET /api/v1/system/tasks', () => services.scheduler.list());
  route(
    app,
    'PUT /api/v1/system/tasks/:name',
    async (c) => services.scheduler.update(parseParams(c, TaskParamsSchema).name, await parseBody(c, TaskUpdateSchema)),
    { params: TaskParamsSchema, body: TaskUpdateSchema },
  );
  route(
    app,
    'POST /api/v1/system/tasks/:name/run',
    (c) => services.scheduler.runNow(parseParams(c, TaskParamsSchema).name),
    {
      params: TaskParamsSchema,
    },
  );

  route(app, 'GET /api/v1/libraries', () => services.libraries.list());
  route(app, 'POST /api/v1/libraries', async (c) => services.libraries.create(await parseBody(c, LibraryInputSchema)), {
    body: LibraryInputSchema,
  });
  route(app, 'GET /api/v1/libraries/:id', (c) => services.libraries.get(parseId(c)), { params: idParamSchema });
  route(
    app,
    'PUT /api/v1/libraries/:id',
    async (c) => services.libraries.update(parseId(c), await parseBody(c, LibraryInputSchema)),
    { params: idParamSchema, body: LibraryInputSchema },
  );
  route(
    app,
    'DELETE /api/v1/libraries/:id',
    async (c) => {
      await services.libraries.remove(parseId(c));
      return undefined;
    },
    { params: idParamSchema },
  );
  route(app, 'GET /api/v1/filesystem', (c) => services.libraries.browse(parseQuery(c, FilesystemQuerySchema)), {
    query: FilesystemQuerySchema,
  });

  route(app, 'GET /api/v1/media', (c) => services.media.list(parseQuery(c, MediaQuerySchema)), {
    query: MediaQuerySchema,
  });
  route(app, 'GET /api/v1/media/stats', (c) => services.media.stats(parseQuery(c, MediaStatsQuerySchema).libraryId), {
    query: MediaStatsQuerySchema,
  });
  route(app, 'GET /api/v1/media/:id', (c) => services.media.get(parseId(c)), { params: idParamSchema });
  route(app, 'POST /api/v1/media/:id/probe', (c) => services.media.reprobe(parseId(c)), { params: idParamSchema });
  route(app, 'GET /api/v1/media/:id/plan', (c) => services.media.previewPlan(parseId(c)), { params: idParamSchema });
  route(
    app,
    'PUT /api/v1/media/:id/ignore',
    async (c) => services.media.setIgnored(parseId(c), (await parseBody(c, MediaIgnoreBodySchema)).ignored),
    { params: idParamSchema, body: MediaIgnoreBodySchema },
  );

  route(app, 'POST /api/v1/scans', async (c) => services.scan.start(await parseBody(c, ScanRequestSchema)), {
    body: ScanRequestSchema,
  });
  route(app, 'GET /api/v1/scans/current', () => services.scan.current());
  route(app, 'DELETE /api/v1/scans/current', async () => {
    await services.scan.cancel();
    return undefined;
  });
  route(app, 'GET /api/v1/dryrun', (c) => services.dryRun.report(parseQuery(c, DryRunQuerySchema)), {
    query: DryRunQuerySchema,
  });
}
