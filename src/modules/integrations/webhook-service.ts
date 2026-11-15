import type { z } from 'zod';
import type { AppContext } from '../../app/context.ts';
import type { WebhookService } from '../../contracts/integrations.ts';
import { errorMessage } from '../../core/errors.ts';
import type { WebhookResponse } from '../../shared/api-types.ts';
import type { ArrKind } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { listArrInstances } from './store.ts';
import {
  combineWebhookActions,
  radarrImport,
  radarrWebhookSchema,
  resolveWebhookInstance,
  sonarrImport,
  sonarrWebhookSchema,
  type WebhookImport,
  webhookActionFor,
} from './webhook-payload.ts';

interface ParsedWebhook {
  eventType: string;
  instanceName?: string;
  applicationUrl?: string;
  isUpgrade?: boolean;
}

function reply(action: WebhookResponse['action'], message: string, mediaFileIds: number[] = []): WebhookResponse {
  return { accepted: action !== 'error', action, mediaFileIds, message };
}

export function createWebhookService(ctx: AppContext): WebhookService {
  const log = ctx.logs.logger('webhook');

  const handleImport = async (
    kind: ArrKind,
    payload: ParsedWebhook,
    instanceId: number | null,
    extract: () => WebhookImport | null,
  ): Promise<WebhookResponse> => {
    const resolution = resolveWebhookInstance(listArrInstances(ctx.db), {
      kind,
      instanceId,
      instanceName: payload.instanceName,
      applicationUrl: payload.applicationUrl,
    });
    if (!resolution.ok) {
      log.warn('webhook from an unknown instance', { kind, instanceId, reason: resolution.reason });
      return reply('error', resolution.reason);
    }
    const instance = resolution.instance;
    if (!instance.enabled) return reply('ignored', `${instance.name} is disabled in Wololo`);
    if (!ctx.settings.section('media').checkOnImport) return reply('ignored', 'checking on import is turned off');

    const imported = extract();
    if (!imported || imported.files.length === 0) {
      log.warn('import webhook without a file path', { instance: instance.name, eventType: payload.eventType });
      return reply('error', 'the payload names no imported file');
    }

    const originalLanguage = normalizeLanguage(imported.originalLanguage);
    const actions: WebhookResponse['action'][] = [];
    const mediaFileIds: number[] = [];
    const messages: string[] = [];
    for (const file of imported.files) {
      let localPath = file.remotePath;
      try {
        localPath = await ctx.services.pathMappings.toLocal(kind, file.remotePath, instance.id);
        const result = await ctx.services.media.checkPath(localPath, {
          trigger: 'webhook',
          arr: { instanceId: instance.id, kind, itemId: imported.itemId, fileId: file.fileId },
          originalLanguage,
        });
        actions.push(webhookActionFor(result.action));
        if (result.mediaFile) mediaFileIds.push(result.mediaFile.id);
        messages.push(result.message);
        log.info('import checked', {
          instance: instance.name,
          path: localPath,
          upgrade: payload.isUpgrade ?? false,
          action: result.action,
        });
      } catch (error) {
        log.error('import check failed', { instance: instance.name, path: localPath, error });
        actions.push('error');
        messages.push(`${localPath}: ${errorMessage(error)}`);
      }
    }
    return reply(combineWebhookActions(actions), messages.join('; '), mediaFileIds);
  };

  const handle = async <T extends ParsedWebhook>(
    kind: ArrKind,
    schema: z.ZodType<T>,
    raw: unknown,
    instanceId: number | null,
    extract: (payload: T) => WebhookImport | null,
  ): Promise<WebhookResponse> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      log.warn('invalid webhook payload', { kind, issues: parsed.error.issues.slice(0, 5) });
      return reply('error', 'invalid webhook payload');
    }
    const payload = parsed.data;
    if (payload.eventType === 'Test') return reply('test', `${kind} test received`);
    if (payload.eventType !== 'Download') return reply('ignored', `event ${payload.eventType} is not handled`);
    return handleImport(kind, payload, instanceId, () => extract(payload));
  };

  return {
    handleRadarr: (payload, instanceId) => handle('radarr', radarrWebhookSchema, payload, instanceId, radarrImport),
    handleSonarr: (payload, instanceId) => handle('sonarr', sonarrWebhookSchema, payload, instanceId, sonarrImport),
  };
}
