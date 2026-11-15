import { posix } from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../app/context.ts';
import type { WebhookService } from '../../contracts/integrations.ts';
import { errorMessage } from '../../core/errors.ts';
import type { WebhookResponse } from '../../shared/api-types.ts';
import type { ArrKind } from '../../shared/domain.ts';
import { normalizeLanguage } from '../../shared/language.ts';
import { hasParentSegment } from './path-map.ts';
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

const envelopeSchema = z.object({ eventType: z.string() });

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
      if (hasParentSegment(file.remotePath)) {
        log.warn('import path with a ".." segment rejected', { instance: instance.name, path: file.remotePath });
        actions.push('error');
        messages.push(`${file.remotePath}: paths with ".." segments are not accepted`);
        continue;
      }
      try {
        localPath = posix.normalize(await ctx.services.pathMappings.toLocal(kind, file.remotePath, instance.id));
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
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      log.warn('webhook payload without an eventType', { kind });
      return reply('error', 'invalid webhook payload');
    }
    const { eventType } = envelope.data;
    if (eventType === 'Test') return reply('test', `${kind} test received`);
    if (eventType !== 'Download') return reply('ignored', `event ${eventType} is not handled`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      log.warn('invalid webhook payload', { kind, issues: parsed.error.issues.slice(0, 5) });
      return reply('error', 'invalid webhook payload');
    }
    const payload = parsed.data;
    return handleImport(kind, payload, instanceId, () => extract(payload));
  };

  return {
    handleRadarr: (payload, instanceId) => handle('radarr', radarrWebhookSchema, payload, instanceId, radarrImport),
    handleSonarr: (payload, instanceId) => handle('sonarr', sonarrWebhookSchema, payload, instanceId, sonarrImport),
  };
}
