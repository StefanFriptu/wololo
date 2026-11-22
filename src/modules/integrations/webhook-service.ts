import { posix } from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../app/context.ts';
import type { WebhookService } from '../../contracts/integrations.ts';
import type { MediaRefs } from '../../contracts/probe-scan.ts';
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

interface FileOutcome {
  action: WebhookResponse['action'];
  mediaFileId: number | null;
  message: string;
}

export interface WebhookDeps {
  /** How long a reply waits for the import checks; Radarr/Sonarr block their import thread on it. */
  replyBudgetMs?: number;
}

const DEFAULT_REPLY_BUDGET_MS = 10_000;

function reply(action: WebhookResponse['action'], message: string, mediaFileIds: number[] = []): WebhookResponse {
  return { accepted: action !== 'error', action, mediaFileIds, message };
}

export function createWebhookService(ctx: AppContext, deps: WebhookDeps = {}): WebhookService {
  const log = ctx.logs.logger('webhook');
  const replyBudgetMs = deps.replyBudgetMs ?? DEFAULT_REPLY_BUDGET_MS;
  const inFlight = new Map<string, Promise<FileOutcome>>();

  const withinBudget = async (work: Promise<WebhookResponse>): Promise<WebhookResponse> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<WebhookResponse>((resolve) => {
      timer = setTimeout(() => resolve(reply('accepted', 'the check continues in the background')), replyBudgetMs);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };

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
    const checkPath = async (localPath: string, refs: MediaRefs): Promise<FileOutcome> => {
      const result = await ctx.services.media.checkPath(localPath, refs);
      log.info('import checked', {
        instance: instance.name,
        path: localPath,
        upgrade: payload.isUpgrade ?? false,
        action: result.action,
      });
      return {
        action: webhookActionFor(result.action),
        mediaFileId: result.mediaFile?.id ?? null,
        message: result.message,
      };
    };
    const checkFile = async (file: WebhookImport['files'][number]): Promise<FileOutcome> => {
      if (hasParentSegment(file.remotePath)) {
        log.warn('import path with a ".." segment rejected', { instance: instance.name, path: file.remotePath });
        return {
          action: 'error',
          mediaFileId: null,
          message: `${file.remotePath}: paths with ".." segments are not accepted`,
        };
      }
      let localPath = file.remotePath;
      try {
        localPath = posix.normalize(await ctx.services.pathMappings.toLocal(kind, file.remotePath, instance.id));
        const pending = inFlight.get(localPath);
        if (pending) return await pending;
        const check = checkPath(localPath, {
          trigger: 'webhook',
          arr: { instanceId: instance.id, kind, itemId: imported.itemId, fileId: file.fileId },
          originalLanguage,
        });
        inFlight.set(localPath, check);
        try {
          return await check;
        } finally {
          inFlight.delete(localPath);
        }
      } catch (error) {
        log.error('import check failed', { instance: instance.name, path: localPath, error });
        return { action: 'error', mediaFileId: null, message: `${localPath}: ${errorMessage(error)}` };
      }
    };

    const work = (async () => {
      const outcomes: FileOutcome[] = [];
      for (const file of imported.files) outcomes.push(await checkFile(file));
      return reply(
        combineWebhookActions(outcomes.map((outcome) => outcome.action)),
        outcomes.map((outcome) => outcome.message).join('; '),
        outcomes.flatMap((outcome) => (outcome.mediaFileId == null ? [] : [outcome.mediaFileId])),
      );
    })();
    return withinBudget(work);
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
    if (eventType === 'Test') {
      ctx.events.emit('webhook.test', { kind, instanceId });
      return reply('test', `${kind} test received`);
    }
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
