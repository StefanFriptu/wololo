import { z } from 'zod';
import { type FetchLike, upstreamFetch, upstreamJson } from './upstream.ts';

export const PLEX_PRODUCT = 'Wololo';

const pinSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  authToken: z.string().nullish(),
  expiresAt: z.string().nullish(),
  expiresIn: z.number().nullish(),
});
const userSchema = z.object({ username: z.string().nullish(), title: z.string().nullish() });
const resourceSchema = z.object({
  name: z.string(),
  provides: z.string().nullish(),
  clientIdentifier: z.string(),
  owned: z.boolean().nullish(),
  accessToken: z.string().nullish(),
  connections: z
    .array(z.object({ uri: z.string(), local: z.boolean().nullish(), relay: z.boolean().nullish() }))
    .nullish(),
});
const identitySchema = z.object({
  MediaContainer: z.object({
    friendlyName: z.string().nullish(),
    machineIdentifier: z.string().nullish(),
    version: z.string().nullish(),
  }),
});
const sectionsSchema = z.object({
  MediaContainer: z.object({
    Directory: z
      .array(
        z.object({
          key: z.union([z.string(), z.number()]).transform(String),
          title: z.string(),
          type: z.string(),
          Location: z.array(z.object({ path: z.string() })).nullish(),
        }),
      )
      .nullish(),
  }),
});
const sessionsSchema = z.object({
  MediaContainer: z.object({
    size: z.number().nullish(),
    Metadata: z
      .array(
        z.object({
          title: z.string().nullish(),
          grandparentTitle: z.string().nullish(),
          type: z.string().nullish(),
          User: z.object({ title: z.string().nullish() }).nullish(),
          Player: z.object({ state: z.string().nullish() }).nullish(),
          TranscodeSession: z
            .object({ videoDecision: z.string().nullish(), audioDecision: z.string().nullish() })
            .nullish(),
        }),
      )
      .nullish(),
  }),
});

export type PlexPinResponse = z.infer<typeof pinSchema>;
export type PlexResource = z.infer<typeof resourceSchema>;
export type PlexRawSection = NonNullable<z.infer<typeof sectionsSchema>['MediaContainer']['Directory']>[number];
export type PlexRawSession = NonNullable<z.infer<typeof sessionsSchema>['MediaContainer']['Metadata']>[number];

interface ClientBase {
  clientIdentifier: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function plexHeaders(clientIdentifier: string, token?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Client-Identifier': clientIdentifier,
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

/** plex.tv account API v2 (PIN sign-in, user, resources). */
export function createPlexTvClient(options: ClientBase & { baseUrl: string }) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const get = <T extends z.ZodType>(path: string, schema: T, init: { method?: string; token?: string } = {}) =>
    upstreamJson(
      {
        service: 'plex.tv',
        url: `${base}/api/v2/${path}`,
        method: init.method,
        headers: plexHeaders(options.clientIdentifier, init.token),
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      },
      schema,
    );
  return {
    createPin: () => get('pins?strong=true', pinSchema, { method: 'POST' }),
    pin: (id: number) => get(`pins/${id}`, pinSchema),
    user: (token: string) => get('user', userSchema, { token }),
    resources: (token: string) => get('resources?includeHttps=1&includeRelay=1', z.array(resourceSchema), { token }),
  };
}

/** One Plex Media Server, authenticated with X-Plex-Token. */
export function createPlexServerClient(options: ClientBase & { url: string; token: string | null }) {
  const base = options.url.replace(/\/+$/, '');
  const request = { service: 'Plex', fetch: options.fetch, timeoutMs: options.timeoutMs };
  const headers = plexHeaders(options.clientIdentifier, options.token);
  const get = <T extends z.ZodType>(path: string, schema: T) =>
    upstreamJson({ ...request, url: `${base}${path}`, headers }, schema);
  return {
    identity: async () => (await get('/', identitySchema)).MediaContainer,
    sections: async () => (await get('/library/sections', sectionsSchema)).MediaContainer.Directory ?? [],
    sessions: async () => (await get('/status/sessions', sessionsSchema)).MediaContainer,
    refresh: async (sectionKey: string, path: string) => {
      const url = new URL(`${base}/library/sections/${encodeURIComponent(sectionKey)}/refresh`);
      url.searchParams.set('path', path);
      const response = await upstreamFetch({ ...request, url, headers });
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
