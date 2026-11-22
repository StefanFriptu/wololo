import { z } from 'zod';
import type { ApiApp } from '../../api/http.ts';
import { idParamSchema, parseBody, parseId, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import type { ProfileCloneBody } from '../../shared/api-types.ts';
import { ProfileInputSchema } from './ProfileInputSchema.ts';

const ProfileCloneBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
}) satisfies z.ZodType<ProfileCloneBody>;

export function registerRulesFfmpegRoutes(app: ApiApp, ctx: AppContext): void {
  const profiles = () => ctx.services.profiles;

  route(app, 'GET /api/v1/profiles', () => profiles().list());
  route(app, 'POST /api/v1/profiles', async (c) => profiles().create(await parseBody(c, ProfileInputSchema)), {
    body: ProfileInputSchema,
  });
  route(app, 'GET /api/v1/profiles/codecs', () => profiles().codecCatalog());
  route(app, 'GET /api/v1/profiles/templates', () => profiles().templates());
  route(app, 'GET /api/v1/profiles/:id', (c) => profiles().get(parseId(c)), { params: idParamSchema });
  route(
    app,
    'PUT /api/v1/profiles/:id',
    async (c) => profiles().update(parseId(c), await parseBody(c, ProfileInputSchema)),
    { params: idParamSchema, body: ProfileInputSchema },
  );
  route(
    app,
    'DELETE /api/v1/profiles/:id',
    async (c) => {
      await profiles().remove(parseId(c));
      return undefined;
    },
    { params: idParamSchema },
  );
  route(
    app,
    'POST /api/v1/profiles/:id/clone',
    async (c) => profiles().clone(parseId(c), (await parseBody(c, ProfileCloneBodySchema)).name),
    { params: idParamSchema, body: ProfileCloneBodySchema },
  );
}
