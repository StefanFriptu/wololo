import { z } from 'zod';
import { type ApiApp, idParamSchema, pageQuerySchema, parseBody, parseId, parseQuery, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import { AppError } from '../../core/errors.ts';
import {
  type HistoryEventType,
  JOB_STATES,
  JOB_TYPES,
  MEDIA_FILE_KINDS,
  MEDIA_FILE_STATUSES,
} from '../../shared/domain.ts';

const HISTORY_EVENT_FLAGS: Record<HistoryEventType, true> = {
  queued: true,
  started: true,
  completed: true,
  failed: true,
  cancelled: true,
  retried: true,
  skipped: true,
  recycled: true,
  restored: true,
  purged: true,
  imported: true,
  source_deleted: true,
};
const HISTORY_EVENTS = Object.keys(HISTORY_EVENT_FLAGS) as [HistoryEventType, ...HistoryEventType[]];

const stateListSchema = z
  .string()
  .refine(
    (value) => value.split(',').every((state) => (JOB_STATES as readonly string[]).includes(state.trim())),
    `expected one or more of ${JOB_STATES.join(', ')}`,
  );

const jobQuerySchema = pageQuerySchema.extend({
  state: stateListSchema.optional(),
  type: z.enum(JOB_TYPES).optional(),
  mediaFileId: z.coerce.number().int().positive().optional(),
});

const enqueueSchema = z
  .object({
    mediaFileIds: z.array(z.number().int().positive()).min(1).max(10_000).optional(),
    filter: z
      .object({
        libraryId: z.number().int().positive().optional(),
        status: z.enum(MEDIA_FILE_STATUSES).optional(),
        failingCodec: z.string().min(1).optional(),
        kind: z.enum(MEDIA_FILE_KINDS).optional(),
        profileId: z.number().int().positive().optional(),
      })
      .optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    force: z.boolean().optional(),
  })
  .refine((body) => (body.mediaFileIds === undefined) !== (body.filter === undefined), {
    message: 'pass exactly one of mediaFileIds or filter',
  });

const historyQuerySchema = pageQuerySchema.extend({
  event: z.enum(HISTORY_EVENTS).optional(),
  mediaFileId: z.coerce.number().int().positive().optional(),
  jobId: z.coerce.number().int().positive().optional(),
});

const purgeSchema = z.object({ all: z.boolean().optional() });

export function registerJobsRoutes(app: ApiApp, ctx: AppContext): void {
  const jobs = () => ctx.services.jobs;
  const recycleBin = () => ctx.services.recycleBin;

  route(app, 'GET /api/v1/queue', () => jobs().queue());
  route(app, 'POST /api/v1/queue/pause', () => jobs().pause('user'));
  route(app, 'POST /api/v1/queue/resume', () => jobs().resume('user'));

  route(app, 'GET /api/v1/jobs', (c) => jobs().list(parseQuery(c, jobQuerySchema)), { query: jobQuerySchema });
  route(app, 'POST /api/v1/jobs', async (c) => jobs().enqueueMany(await parseBody(c, enqueueSchema)), {
    body: enqueueSchema,
  });
  route(app, 'GET /api/v1/jobs/:id', (c) => jobs().get(parseId(c)), { params: idParamSchema });
  route(
    app,
    'GET /api/v1/jobs/:id/log',
    async (c) => {
      const id = parseId(c);
      const text = await jobs().log(id);
      if (text === null) throw new AppError('not_found', `job ${id} has no log`);
      return c.text(text, 200, { 'content-type': 'text/plain; charset=utf-8' });
    },
    { params: idParamSchema },
  );
  route(app, 'POST /api/v1/jobs/:id/cancel', (c) => jobs().cancel(parseId(c)), { params: idParamSchema });
  route(app, 'POST /api/v1/jobs/:id/retry', (c) => jobs().retry(parseId(c)), { params: idParamSchema });
  route(
    app,
    'DELETE /api/v1/jobs/:id',
    async (c) => {
      await jobs().remove(parseId(c));
      return undefined;
    },
    { params: idParamSchema },
  );
  route(app, 'GET /api/v1/history', (c) => jobs().history(parseQuery(c, historyQuerySchema)), {
    query: historyQuerySchema,
  });

  route(app, 'GET /api/v1/recyclebin', (c) => recycleBin().list(parseQuery(c, pageQuerySchema)), {
    query: pageQuerySchema,
  });
  route(app, 'POST /api/v1/recyclebin/purge', async (c) => recycleBin().purge(await parseBody(c, purgeSchema)), {
    body: purgeSchema,
  });
  route(app, 'POST /api/v1/recyclebin/:id/restore', (c) => recycleBin().restore(parseId(c)), {
    params: idParamSchema,
  });
  route(
    app,
    'DELETE /api/v1/recyclebin/:id',
    async (c) => {
      await recycleBin().remove(parseId(c));
      return undefined;
    },
    { params: idParamSchema },
  );
}
