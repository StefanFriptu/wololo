import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, parseBody, registerNotImplemented, route } from '../../src/api/http.ts';
import { errorHandler } from '../../src/api/middleware.ts';
import { LogHub } from '../../src/core/logger.ts';

const makeApp = () => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(new LogHub({ level: 'error', logDir: null, console: false }).logger('t')));
  return app;
};

test('route - undefined result answers 204 with no body', async () => {
  const app = makeApp();
  route(app, 'DELETE /api/v1/jobs/:id', () => undefined);
  const response = await app.request('/api/v1/jobs/1', { method: 'DELETE' });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
});

test('route - real handler registered first wins over the 501 stub', async () => {
  const app = makeApp();
  route(app, 'POST /api/v1/queue/pause', () => ({
    paused: true,
    pauseReasons: ['user'],
    running: 0,
    queued: 0,
    concurrency: 1,
  }));
  registerNotImplemented(app, ['POST /api/v1/queue/pause', 'POST /api/v1/queue/resume']);
  expect((await app.request('/api/v1/queue/pause', { method: 'POST' })).status).toBe(200);
  expect((await app.request('/api/v1/queue/resume', { method: 'POST' })).status).toBe(501);
});

test('parseBody - invalid JSON and schema violations answer 400 validation', async () => {
  const app = makeApp();
  route(app, 'POST /api/v1/jobs', async (c) => {
    await parseBody(c, z.object({ mediaFileIds: z.array(z.number()) }));
    return { jobs: [], skipped: [] };
  });
  for (const body of ['{not json', '{"mediaFileIds":"x"}']) {
    const response = await app.request('/api/v1/jobs', {
      method: 'POST',
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation' });
  }
});

test('errorHandler - unknown errors answer a generic 500 without SQL or params', async () => {
  const app = makeApp();
  app.get('/boom', () => {
    throw new Error('Failed query: select * from media_files where path = ?\nparams: /secret/path.mkv');
  });
  const response = await app.request('/boom');
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain('Failed query');
  expect(text).not.toContain('/secret/path.mkv');
  expect(JSON.parse(text)).toEqual({ error: 'internal', message: 'internal error' });
});
