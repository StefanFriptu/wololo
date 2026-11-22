import { z } from 'zod';
import { type ApiApp, idParamSchema, parseBody, parseId, parseQuery, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import type {
  ArrInstanceInput,
  ArrLookupQuery,
  ArrTestRequest,
  ArrWebhookRequest,
  DownloadClientInput,
  PathMappingInput,
  PlexConnectionUpdate,
  WebhookQuery,
} from '../../shared/api-types.ts';
import { ARR_KINDS, PATH_MAPPING_SCOPES } from '../../shared/domain.ts';
import { radarrWebhookSchema, sonarrWebhookSchema } from './webhook-payload.ts';

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'expected an http(s) URL');

const arrInstanceSchema = z.object({
  kind: z.enum(ARR_KINDS),
  name: z.string().trim().min(1).max(64),
  url: httpUrl,
  apiKey: z.string().min(1),
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<ArrInstanceInput>;

const arrTestSchema = arrInstanceSchema.extend({
  id: z.number().int().positive().optional(),
}) satisfies z.ZodType<ArrTestRequest>;

const webhookRequestSchema = z.object({ address: httpUrl }) satisfies z.ZodType<ArrWebhookRequest>;

const lookupQuerySchema = z.object({
  term: z.string().trim().min(1),
  year: z.coerce.number().int().min(1870).max(2200).optional(),
}) satisfies z.ZodType<ArrLookupQuery>;

const webhookQuerySchema = z.object({
  instance: z.coerce.number().int().positive().optional(),
}) satisfies z.ZodType<WebhookQuery>;

/** Only eventType is required at the boundary; the service validates the rest and answers 200 with action "error". */
const webhookEnvelopeSchema = z.looseObject({ eventType: z.string().min(1) });

const plexUpdateSchema = z.object({
  serverMachineId: z.string().min(1).optional(),
  serverUrl: httpUrl.optional(),
  serverToken: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  partialScan: z.boolean().optional(),
  pauseWhileStreaming: z.boolean().optional(),
}) satisfies z.ZodType<PlexConnectionUpdate>;

const downloadClientSchema = z.object({
  kind: z.literal('qbittorrent').default('qbittorrent'),
  enabled: z.boolean().default(true),
  url: httpUrl,
  username: z.string().default(''),
  password: z.string().default(''),
  removeWhenGoalMet: z.boolean().default(false),
  category: z
    .string()
    .trim()
    .nullish()
    .transform((value) => value || null),
}) satisfies z.ZodType<DownloadClientInput>;

const pathMappingSchema = z.object({
  scope: z.enum(PATH_MAPPING_SCOPES),
  instanceId: z.number().int().positive().nullish(),
  remotePath: z.string().trim().min(1),
  localPath: z.string().trim().min(1),
}) satisfies z.ZodType<PathMappingInput>;

async function noContent(work: Promise<void>): Promise<undefined> {
  await work;
  return undefined;
}

export function registerIntegrationsRoutes(app: ApiApp, ctx: AppContext): void {
  const services = ctx.services;
  const idParams = { params: idParamSchema };

  route(app, 'GET /api/v1/arr', () => services.arr.list());
  route(app, 'POST /api/v1/arr', async (c) => services.arr.create(await parseBody(c, arrInstanceSchema)), {
    body: arrInstanceSchema,
  });
  route(app, 'POST /api/v1/arr/test', async (c) => services.arr.test(await parseBody(c, arrTestSchema)), {
    body: arrTestSchema,
  });
  route(app, 'GET /api/v1/arr/:id', (c) => services.arr.get(parseId(c)), idParams);
  route(
    app,
    'PUT /api/v1/arr/:id',
    async (c) => services.arr.update(parseId(c), await parseBody(c, arrInstanceSchema)),
    {
      ...idParams,
      body: arrInstanceSchema,
    },
  );
  route(app, 'DELETE /api/v1/arr/:id', (c) => noContent(services.arr.remove(parseId(c))), idParams);
  route(app, 'GET /api/v1/arr/:id/rootfolders', (c) => services.arr.rootFolders(parseId(c)), idParams);
  route(app, 'GET /api/v1/arr/:id/qualityprofiles', (c) => services.arr.qualityProfiles(parseId(c)), idParams);
  route(app, 'GET /api/v1/arr/:id/webhook', (c) => services.arr.webhook(parseId(c)), idParams);
  route(
    app,
    'PUT /api/v1/arr/:id/webhook',
    async (c) => services.arr.ensureWebhook(parseId(c), (await parseBody(c, webhookRequestSchema)).address),
    { ...idParams, body: webhookRequestSchema },
  );
  route(app, 'POST /api/v1/arr/:id/webhook/test', (c) => services.arr.testWebhook(parseId(c)), idParams);
  route(app, 'GET /api/v1/arr/:id/pathcheck', (c) => services.arr.checkPaths(parseId(c)), idParams);
  route(
    app,
    'GET /api/v1/arr/:id/lookup',
    (c) => {
      const query = parseQuery(c, lookupQuerySchema);
      return services.arr.lookupMovie(parseId(c), query.term, query.year ?? null);
    },
    { ...idParams, query: lookupQuerySchema },
  );

  route(
    app,
    'POST /api/v1/webhook/radarr',
    async (c) => {
      const { instance } = parseQuery(c, webhookQuerySchema);
      const payload = await parseBody(c, webhookEnvelopeSchema);
      return services.webhooks.handleRadarr(payload, instance ?? null);
    },
    { query: webhookQuerySchema, body: radarrWebhookSchema },
  );
  route(
    app,
    'POST /api/v1/webhook/sonarr',
    async (c) => {
      const { instance } = parseQuery(c, webhookQuerySchema);
      const payload = await parseBody(c, webhookEnvelopeSchema);
      return services.webhooks.handleSonarr(payload, instance ?? null);
    },
    { query: webhookQuerySchema, body: sonarrWebhookSchema },
  );

  route(app, 'GET /api/v1/plex', () => services.plex.connection());
  route(app, 'PUT /api/v1/plex', async (c) => services.plex.update(await parseBody(c, plexUpdateSchema)), {
    body: plexUpdateSchema,
  });
  route(app, 'DELETE /api/v1/plex', () => services.plex.signOut());
  route(app, 'POST /api/v1/plex/pin', () => services.plex.createPin());
  route(app, 'GET /api/v1/plex/pin/:id', (c) => services.plex.checkPin(parseId(c)), idParams);
  route(app, 'GET /api/v1/plex/servers', () => services.plex.servers());
  route(app, 'GET /api/v1/plex/sections', () => services.plex.sections());
  route(app, 'POST /api/v1/plex/test', () => services.plex.test());
  route(app, 'GET /api/v1/plex/sessions', () => services.plex.sessions());

  route(app, 'GET /api/v1/downloadclient', () => services.downloadClient.get());
  route(
    app,
    'PUT /api/v1/downloadclient',
    async (c) => services.downloadClient.save(await parseBody(c, downloadClientSchema)),
    {
      body: downloadClientSchema,
    },
  );
  route(app, 'DELETE /api/v1/downloadclient', () => noContent(services.downloadClient.remove()));
  route(
    app,
    'POST /api/v1/downloadclient/test',
    async (c) => services.downloadClient.test(await parseBody(c, downloadClientSchema)),
    { body: downloadClientSchema },
  );

  route(app, 'GET /api/v1/pathmappings', () => services.pathMappings.list());
  route(
    app,
    'POST /api/v1/pathmappings',
    async (c) => services.pathMappings.create(await parseBody(c, pathMappingSchema)),
    {
      body: pathMappingSchema,
    },
  );
  route(
    app,
    'PUT /api/v1/pathmappings/:id',
    async (c) => services.pathMappings.update(parseId(c), await parseBody(c, pathMappingSchema)),
    { ...idParams, body: pathMappingSchema },
  );
  route(app, 'DELETE /api/v1/pathmappings/:id', (c) => noContent(services.pathMappings.remove(parseId(c))), idParams);
}
