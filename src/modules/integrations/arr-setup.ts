import { existsSync } from 'node:fs';
import type { AppContext } from '../../app/context.ts';
import type { ArrService } from '../../contracts/integrations.ts';
import { errorMessage } from '../../core/errors.ts';
import type { ArrWebhookStatus } from '../../shared/api-types.ts';
import type { ArrInstance } from '../../shared/domain.ts';
import { webhookUrl } from '../../shared/webhookUrl.ts';
import type { ArrClient, ArrNotification } from './arr-client.ts';
import { joinRemotePath } from './path-map.ts';
import { maskSecret } from './secrets.ts';
import { suggestPathMapping } from './suggest-path-mapping.ts';
import { upstreamErrorBody } from './upstream.ts';
import {
  isWebhookTemplate,
  isWololoWebhook,
  notificationField,
  notificationTestMessage,
  wololoWebhook,
} from './webhook-notification.ts';

/** Sonarr lists every series; only this many are asked for their episode files when looking for a real file. */
const MAX_SERIES_PROBED = 5;

interface ArrSetupDeps {
  requireInstance: (id: number) => ArrInstance;
  clientFor: (instance: ArrInstance) => ArrClient;
  libraryTimeoutMs: number;
}

type ArrSetup = Pick<ArrService, 'webhook' | 'ensureWebhook' | 'testWebhook' | 'checkPaths'>;

function maskedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const key = parsed.searchParams.get('apikey');
    if (key) parsed.searchParams.set('apikey', maskSecret(key));
    return parsed.href;
  } catch {
    return url;
  }
}

function statusOf(notification: ArrNotification | undefined): ArrWebhookStatus {
  if (!notification) return { configured: false, url: null, triggersOk: false };
  const url = notificationField(notification, 'url');
  return {
    configured: true,
    url: typeof url === 'string' ? maskedUrl(url) : null,
    triggersOk: notification.onDownload === true && notification.onUpgrade === true,
  };
}

async function firstRemoteFile(instance: ArrInstance, client: ArrClient, timeoutMs: number): Promise<string | null> {
  if (instance.kind === 'radarr') {
    for (const movie of await client.movies(timeoutMs)) {
      const file = movie.movieFile;
      if (file?.path) return file.path;
      if (file?.relativePath && movie.path) return joinRemotePath(movie.path, file.relativePath);
    }
    return null;
  }
  const withFiles = (await client.series(timeoutMs))
    .filter((series) => (series.statistics?.episodeFileCount ?? 1) > 0)
    .slice(0, MAX_SERIES_PROBED);
  for (const series of withFiles) {
    const file = (await client.episodeFiles(series.id))[0];
    if (file?.path) return file.path;
    if (file?.relativePath && series.path) return joinRemotePath(series.path, file.relativePath);
  }
  return null;
}

export function createArrSetup(ctx: AppContext, deps: ArrSetupDeps): ArrSetup {
  const log = ctx.logs.logger('arr');

  const findWebhook = async (instance: ArrInstance, client: ArrClient) =>
    (await client.notifications()).find((entry) =>
      isWololoWebhook(entry, { kind: instance.kind, instanceId: instance.id }),
    );

  return {
    webhook: async (id) => {
      const instance = deps.requireInstance(id);
      return statusOf(await findWebhook(instance, deps.clientFor(instance)));
    },

    ensureWebhook: async (id, address) => {
      const instance = deps.requireInstance(id);
      const client = deps.clientFor(instance);
      const { apiKey, urlBase } = ctx.config.get();
      const url = webhookUrl({ origin: address, urlBase, kind: instance.kind, instanceId: id, apiKey });
      const existing = await findWebhook(instance, client);
      if (existing?.id != null) {
        const updated = await client.updateNotification({ ...wololoWebhook(existing, url), id: existing.id });
        log.info('webhook updated', { instance: instance.name, notificationId: existing.id });
        return statusOf(updated);
      }
      const template = (await client.notificationTemplates()).find(isWebhookTemplate);
      const created = await client.createNotification(
        wololoWebhook(template ?? { implementation: 'Webhook', fields: [] }, url),
      );
      log.info('webhook added', { instance: instance.name, notificationId: created.id ?? null });
      return statusOf(created);
    },

    testWebhook: async (id) => {
      const instance = deps.requireInstance(id);
      const client = deps.clientFor(instance);
      const existing = await findWebhook(instance, client);
      if (!existing) {
        return { sent: false, received: false, message: `Wololo's webhook is not set up in ${client.service}` };
      }
      let received = false;
      const stop = ctx.events.on('webhook.test', (event) => {
        if (event.kind === instance.kind && (event.instanceId == null || event.instanceId === id)) received = true;
      });
      try {
        await client.testNotification(existing);
        return {
          sent: true,
          received,
          message: received
            ? `${client.service} reached Wololo`
            : `${client.service} sent its test event, but it did not arrive here`,
        };
      } catch (error) {
        const reason = notificationTestMessage(upstreamErrorBody(error)) ?? errorMessage(error);
        return { sent: false, received, message: reason };
      } finally {
        stop();
      }
    },

    checkPaths: async (id) => {
      const instance = deps.requireInstance(id);
      const client = deps.clientFor(instance);
      const remotePath = await firstRemoteFile(instance, client, deps.libraryTimeoutMs);
      if (!remotePath) {
        return {
          ok: true,
          message: `${client.service} has no files yet; the folders are checked on the first import`,
          remotePath: null,
          localPath: null,
          suggestion: null,
        };
      }
      const localPath = await ctx.services.pathMappings.toLocal(instance.kind, remotePath, id);
      if (existsSync(localPath)) {
        return { ok: true, message: `Found ${localPath}`, remotePath, localPath, suggestion: null };
      }
      const roots = (await ctx.services.libraries.list()).flatMap((library) => library.roots.map((root) => root.path));
      const found = suggestPathMapping({ remotePath, localRoots: roots, exists: existsSync });
      return {
        ok: false,
        message:
          localPath === remotePath
            ? `Wololo cannot see ${remotePath}, a file ${client.service} has`
            : `${client.service} has ${remotePath}, but Wololo cannot see it at ${localPath}`,
        remotePath,
        localPath,
        suggestion: found && { scope: instance.kind, instanceId: id, ...found },
      };
    },
  };
}
