import { z } from 'zod';
import type { ApiApp } from '../../api/http.ts';
import { idParamSchema, parseBody, parseId, parseQuery, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import type { BdmvDecisionQuery } from '../../shared/api-types.ts';
import type { BdmvDecisionChoice } from '../../shared/domain.ts';

const decisionQuerySchema = z.object({
  state: z.enum(['pending', 'resolved', 'dismissed']).optional(),
}) satisfies z.ZodType<BdmvDecisionQuery>;

export const decisionChoiceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('main_title'),
    playlists: z.array(z.string().regex(/^\d{5}\.mpls$/i, 'expected a playlist file name such as 00800.mpls')).min(1),
    asEditions: z.boolean().default(false),
    editionNames: z.record(z.string(), z.string().trim().min(1).max(64)).default({}),
  }),
  z.object({ kind: z.literal('movie_match'), tmdbId: z.number().int().positive() }),
  z.object({ kind: z.literal('delete_source'), confirm: z.boolean() }),
]) satisfies z.ZodType<BdmvDecisionChoice, unknown>;

export function registerBdmvRoutes(app: ApiApp, ctx: AppContext): void {
  const bdmv = () => ctx.services.bdmv;

  route(app, 'GET /api/v1/bdmv/decisions', (c) => bdmv().listDecisions(parseQuery(c, decisionQuerySchema)), {
    query: decisionQuerySchema,
  });
  route(app, 'GET /api/v1/bdmv/decisions/:id', (c) => bdmv().getDecision(parseId(c)), { params: idParamSchema });
  route(
    app,
    'POST /api/v1/bdmv/decisions/:id/resolve',
    async (c) => bdmv().resolveDecision(parseId(c), await parseBody(c, decisionChoiceSchema)),
    { params: idParamSchema, body: decisionChoiceSchema },
  );
  route(app, 'POST /api/v1/bdmv/decisions/:id/dismiss', (c) => bdmv().dismissDecision(parseId(c)), {
    params: idParamSchema,
  });
  route(app, 'GET /api/v1/bdmv/discs/:id', (c) => bdmv().analyze(parseId(c)), { params: idParamSchema });
}
