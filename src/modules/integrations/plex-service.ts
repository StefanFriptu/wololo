import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../app/context.ts';
import type { PlexService } from '../../contracts/integrations.ts';
import { AppError, errorMessage, notFound } from '../../core/errors.ts';
import type { PlexConnectionRow } from '../../db/schema.ts';
import type { PlexConnection, PlexSection, PlexServer } from '../../shared/domain.ts';
import type { IntegrationDeps } from './arr-service.ts';
import { createPlexServerClient, createPlexTvClient, PLEX_PRODUCT, type PlexResource } from './plex-client.ts';
import { findSectionForPath, isPublishedConnection, pickConnection, toSession } from './plex-select.ts';
import { ensurePlexRow, type PlexRowPatch, updatePlexRow } from './store.ts';
import { upstreamStatus } from './upstream.ts';

const SECTION_TYPES = new Set<PlexSection['type']>(['movie', 'show', 'artist', 'photo']);
const DEFAULT_PIN_LIFETIME_SEC = 1800;

export interface PlexDeps extends IntegrationDeps {
  plexTvUrl?: string;
  plexAppUrl?: string;
}

function toConnection(row: PlexConnectionRow): PlexConnection {
  return {
    signedIn: row.accountToken != null,
    username: row.username,
    serverName: row.serverName,
    serverMachineId: row.serverMachineId,
    serverUrl: row.serverUrl,
    enabled: row.enabled,
    partialScan: row.partialScan,
    pauseWhileStreaming: row.pauseWhileStreaming,
  };
}

function isSectionType(type: string): type is PlexSection['type'] {
  return SECTION_TYPES.has(type as PlexSection['type']);
}

function providesServer(resource: PlexResource): boolean {
  return (resource.provides ?? '').split(',').includes('server');
}

function toPlexServer(resource: PlexResource): PlexServer {
  return {
    machineId: resource.clientIdentifier,
    name: resource.name,
    owned: resource.owned ?? false,
    connections: (resource.connections ?? []).map((connection) => ({
      uri: connection.uri,
      local: connection.local ?? false,
      relay: connection.relay ?? false,
    })),
  };
}

export function plexAuthUrl(appUrl: string, { clientIdentifier, code }: { clientIdentifier: string; code: string }) {
  const params = new URLSearchParams({
    clientID: clientIdentifier,
    code,
    'context[device][product]': PLEX_PRODUCT,
  });
  return `${appUrl.replace(/\/+$/, '')}/auth#?${params.toString()}`;
}

export function createPlexService(ctx: AppContext, deps: PlexDeps = {}): PlexService {
  const log = ctx.logs.logger('plex');
  const now = deps.now ?? Date.now;
  const plexTvUrl = deps.plexTvUrl ?? 'https://plex.tv';
  const plexAppUrl = deps.plexAppUrl ?? 'https://app.plex.tv';

  const row = () => ensurePlexRow(ctx.db, randomUUID);
  const tv = (current: PlexConnectionRow) =>
    createPlexTvClient({
      baseUrl: plexTvUrl,
      clientIdentifier: current.clientIdentifier,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
    });

  const serverOf = (current: PlexConnectionRow) => {
    if (!current.serverUrl) return null;
    return createPlexServerClient({
      url: current.serverUrl,
      token: current.serverToken,
      clientIdentifier: current.clientIdentifier,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
    });
  };

  const requireServer = (current: PlexConnectionRow) => {
    const server = serverOf(current);
    if (!server) throw new AppError('precondition_failed', 'no Plex server selected');
    return server;
  };

  const requireAccountToken = (current: PlexConnectionRow): string => {
    if (!current.accountToken) throw new AppError('precondition_failed', 'sign in to Plex first');
    return current.accountToken;
  };

  const loadSections = async (current: PlexConnectionRow): Promise<PlexSection[]> => {
    const sections = await requireServer(current).sections();
    return sections.flatMap((section) =>
      isSectionType(section.type)
        ? [
            {
              key: section.key,
              title: section.title,
              type: section.type,
              locations: (section.Location ?? []).map((location) => location.path),
            },
          ]
        : [],
    );
  };

  const findServer = async (current: PlexConnectionRow, machineId: string): Promise<PlexResource | null> => {
    const resources = await tv(current).resources(requireAccountToken(current));
    return resources.find((resource) => resource.clientIdentifier === machineId && providesServer(resource)) ?? null;
  };

  const selectServer = async (current: PlexConnectionRow, machineId: string, serverUrl: string | undefined) => {
    const server = await findServer(current, machineId);
    if (!server) throw notFound(`Plex server ${machineId}`);
    if (serverUrl && !isPublishedConnection(serverUrl, server.connections ?? [])) {
      throw new AppError(
        'unprocessable',
        `${serverUrl} is not one of the addresses plex.tv lists for ${server.name}; pick one of them`,
      );
    }
    const url = serverUrl ?? pickConnection(toPlexServer(server).connections)?.uri;
    if (!url) throw new AppError('unprocessable', `Plex server ${server.name} offers no connection`);
    return {
      serverMachineId: server.clientIdentifier,
      serverName: server.name,
      serverUrl: url,
      serverToken: server.accessToken ?? current.accountToken,
    } satisfies PlexRowPatch;
  };

  /**
   * A URL without serverMachineId keeps the selected server's token only when plex.tv lists that URL's host for it.
   * Any other URL gets the caller's own serverToken, else no token (it works when Plex allows this network without
   * auth), so the stored tokens never reach a server the caller picked.
   */
  const manualServer = async (
    current: PlexConnectionRow,
    serverUrl: string,
    serverToken: string | undefined,
  ): Promise<PlexRowPatch> => {
    if (current.serverMachineId && current.accountToken) {
      const server = await findServer(current, current.serverMachineId).catch((error: unknown) => {
        log.warn('could not verify the Plex URL with plex.tv', { error: errorMessage(error) });
        return null;
      });
      if (server && isPublishedConnection(serverUrl, server.connections ?? [])) return { serverUrl };
    }
    if (!serverToken)
      log.info('Plex URL is not listed by plex.tv for the selected server; it is used without a token', { serverUrl });
    return { serverUrl, serverToken: serverToken ?? null, serverMachineId: null, serverName: null };
  };

  return {
    connection: async () => toConnection(row()),
    update: async (patch) => {
      const current = row();
      const changes: PlexRowPatch = {};
      if (patch.serverMachineId) {
        Object.assign(changes, await selectServer(current, patch.serverMachineId, patch.serverUrl));
      } else if (patch.serverUrl !== undefined) {
        Object.assign(changes, await manualServer(current, patch.serverUrl, patch.serverToken));
      }
      if (patch.enabled !== undefined) changes.enabled = patch.enabled;
      if (patch.partialScan !== undefined) changes.partialScan = patch.partialScan;
      if (patch.pauseWhileStreaming !== undefined) changes.pauseWhileStreaming = patch.pauseWhileStreaming;
      const serverUrl = changes.serverUrl ?? current.serverUrl;
      if (changes.enabled && !serverUrl) throw new AppError('precondition_failed', 'select a Plex server first');
      const updated = updatePlexRow(ctx.db, changes);
      log.info('Plex connection updated', {
        server: updated.serverName ?? updated.serverUrl,
        enabled: updated.enabled,
      });
      ctx.services.jobs.resume('plex_streaming');
      return toConnection(updated);
    },
    signOut: async () => {
      row();
      const cleared = updatePlexRow(ctx.db, {
        accountToken: null,
        username: null,
        serverMachineId: null,
        serverName: null,
        serverUrl: null,
        serverToken: null,
        enabled: false,
        pendingPinId: null,
      });
      log.info('signed out of Plex');
      ctx.services.jobs.resume('plex_streaming');
      return toConnection(cleared);
    },
    createPin: async () => {
      const current = row();
      const pin = await tv(current).createPin();
      updatePlexRow(ctx.db, { pendingPinId: pin.id });
      const expiresAt =
        pin.expiresAt ?? new Date(now() + (pin.expiresIn ?? DEFAULT_PIN_LIFETIME_SEC) * 1000).toISOString();
      return {
        id: pin.id,
        code: pin.code,
        authUrl: plexAuthUrl(plexAppUrl, { clientIdentifier: current.clientIdentifier, code: pin.code }),
        expiresAt,
      };
    },
    checkPin: async (id) => {
      const current = row();
      const client = tv(current);
      let pin: Awaited<ReturnType<typeof client.pin>>;
      try {
        pin = await client.pin(id);
      } catch (error) {
        if (upstreamStatus(error) !== 404) throw error;
        return { authenticated: false, expired: true, connection: toConnection(current) };
      }
      if (!pin.authToken) {
        const expired = pin.expiresAt != null && Date.parse(pin.expiresAt) <= now();
        return { authenticated: false, expired, connection: toConnection(current) };
      }
      const user = await client.user(pin.authToken);
      const updated = updatePlexRow(ctx.db, {
        accountToken: pin.authToken,
        username: user.username ?? user.title ?? null,
        pendingPinId: null,
      });
      log.info('signed in to Plex', { username: updated.username });
      return { authenticated: true, expired: false, connection: toConnection(updated) };
    },
    servers: async () => {
      const current = row();
      const resources = await tv(current).resources(requireAccountToken(current));
      return resources.filter(providesServer).map(toPlexServer);
    },
    sections: async () => loadSections(row()),
    test: async () => {
      const server = serverOf(row());
      if (!server) return { ok: false, message: 'no Plex server selected', version: null };
      try {
        const identity = await server.identity();
        const name = identity.friendlyName ?? identity.machineIdentifier ?? 'Plex Media Server';
        return { ok: true, message: `Connected to ${name}`, version: identity.version ?? null };
      } catch (error) {
        return { ok: false, message: errorMessage(error), version: null };
      }
    },
    refreshPath: async (localPath) => {
      const current = row();
      const server = serverOf(current);
      if (!current.enabled || !server) {
        log.debug('Plex partial scan skipped (Plex not connected)', { path: localPath });
        return;
      }
      if (!current.partialScan) {
        log.info('Plex partial scan skipped: partial scan is off on the Plex page', { path: localPath });
        return;
      }
      const plexPath = await ctx.services.pathMappings.toRemote('plex', localPath);
      const match = findSectionForPath(await loadSections(current), plexPath);
      if (!match) {
        log.warn('no Plex library contains this path; add a Plex path mapping', { path: localPath, plexPath });
        return;
      }
      await server.refresh(match.section.key, plexPath);
      log.info('Plex partial scan requested', { section: match.section.title, path: plexPath });
    },
    sessions: async () => {
      const current = row();
      const server = serverOf(current);
      if (!current.enabled || !server) return { active: 0, sessions: [] };
      try {
        const container = await server.sessions();
        const sessions = (container.Metadata ?? []).map(toSession);
        return { active: container.size ?? sessions.length, sessions };
      } catch (error) {
        log.debug('Plex sessions unavailable', { error: errorMessage(error) });
        return { active: 0, sessions: [] };
      }
    },
  };
}
