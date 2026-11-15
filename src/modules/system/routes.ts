import { z } from 'zod';
import type { ApiApp, ApiContext } from '../../api/http.ts';
import { parseParams, route } from '../../api/http.ts';
import type { AppContext } from '../../app/context.ts';
import { AppError } from '../../core/errors.ts';
import { renderApiDocsPage } from './apiDocsPage.ts';
import { platformOpenApi } from './platformOpenApi.ts';

const backupNameParams = z.object({ name: z.string().min(1).max(255) });
const restoreUploadBody = z.object({ file: z.file().min(1) });

async function parseUpload(c: ApiContext): Promise<Uint8Array> {
  const form = await c.req.formData().catch(() => null);
  const parsed = restoreUploadBody.safeParse({ file: form?.get('file') ?? undefined });
  if (!parsed.success) {
    throw new AppError(
      'validation',
      'expected multipart/form-data with a non-empty "file" field',
      z.treeifyError(parsed.error),
    );
  }
  return new Uint8Array(await parsed.data.file.arrayBuffer());
}

export function registerPlatformRoutes(app: ApiApp, ctx: AppContext): void {
  const system = () => ctx.services.system;
  const backupName = (c: ApiContext) => parseParams(c, backupNameParams).name;

  route(app, 'GET /api/v1/system/status', () => system().status());
  route(app, 'GET /api/v1/system/health', () => system().health());

  route(app, 'GET /api/v1/system/backups', () => system().listBackups());
  route(app, 'POST /api/v1/system/backups', () => system().createBackup('manual'));
  route(app, 'POST /api/v1/system/backups/restore', async (c) => system().restoreUpload(await parseUpload(c)), {
    body: restoreUploadBody,
  });
  route(
    app,
    'GET /api/v1/system/backups/:name',
    async (c) => {
      const name = backupName(c);
      const path = await system().backupPath(name);
      return new Response(Bun.file(path), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}"`,
        },
      });
    },
    { params: backupNameParams },
  );
  route(
    app,
    'DELETE /api/v1/system/backups/:name',
    async (c) => {
      await system().deleteBackup(backupName(c));
      return undefined;
    },
    { params: backupNameParams },
  );
  route(app, 'POST /api/v1/system/backups/:name/restore', (c) => system().restoreBackup(backupName(c)), {
    params: backupNameParams,
  });

  route(app, 'POST /api/v1/system/restart', async () => {
    await system().restart();
    return undefined;
  });
  route(app, 'GET /api/v1/openapi.json', () => system().openApiDocument());
  route(app, 'GET /api/v1/docs', (c) => c.html(renderApiDocsPage(platformOpenApi(ctx.config.get()).document)));
}
