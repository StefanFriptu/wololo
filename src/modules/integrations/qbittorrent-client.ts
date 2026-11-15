import { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { type FetchLike, type UpstreamRequest, upstreamFetch, upstreamStatus } from './upstream.ts';

const SERVICE = 'qBittorrent';

const torrentSchema = z.object({
  hash: z.string(),
  name: z.string(),
  save_path: z.string(),
  content_path: z.string().nullish(),
  state: z.string(),
  progress: z.number(),
  ratio: z.number(),
  seeding_time: z.number().nullish(),
  ratio_limit: z.number().nullish(),
  seeding_time_limit: z.number().nullish(),
  max_ratio: z.number().nullish(),
  max_seeding_time: z.number().nullish(),
  category: z.string().nullish(),
});

export type RawTorrent = z.infer<typeof torrentSchema>;

export interface QbittorrentOptions {
  url: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type QbittorrentClient = ReturnType<typeof createQbittorrentClient>;

function sessionCookie(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  const first = cookies.map((cookie) => cookie.split(';')[0]?.trim()).find((pair) => pair?.includes('='));
  return first ?? null;
}

/** qBittorrent Web API v2 with cookie login; a 403 (expired session) logs in again once. */
export function createQbittorrentClient(options: QbittorrentOptions) {
  const base = options.url.trim().replace(/\/+$/, '');
  let cookie: string | null = null;
  let loggedIn = false;

  const request = (path: string, init: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
    service: SERVICE,
    url: `${base}/api/v2/${path}`,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    ...init,
    headers: { Referer: base, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  });

  const login = async () => {
    const response = await upstreamFetch(
      request('auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: options.username, password: options.password }).toString(),
      }),
    );
    const text = (await response.text()).trim();
    if (text !== 'Ok.') throw new AppError('upstream', `${SERVICE} rejected the username or password`, { status: 401 });
    cookie = sessionCookie(response) ?? cookie;
    loggedIn = true;
  };

  const authed = async (path: string, init: Partial<UpstreamRequest> = {}): Promise<Response> => {
    if (!loggedIn) await login();
    try {
      return await upstreamFetch(request(path, init));
    } catch (error) {
      if (upstreamStatus(error) !== 403) throw error;
      await login();
      return upstreamFetch(request(path, init));
    }
  };

  const form = (values: Record<string, string>): Partial<UpstreamRequest> => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  });

  return {
    version: async () => (await (await authed('app/version')).text()).trim(),
    torrents: async (category: string | null) => {
      const query = category ? `?${new URLSearchParams({ category }).toString()}` : '';
      const body: unknown = await (await authed(`torrents/info${query}`)).json().catch(() => null);
      const parsed = z.array(torrentSchema).safeParse(body);
      if (!parsed.success) throw new AppError('upstream', `${SERVICE} torrents/info: unexpected response`);
      return parsed.data;
    },
    deleteTorrent: async (hash: string, deleteFiles: boolean) => {
      const response = await authed('torrents/delete', form({ hashes: hash, deleteFiles: String(deleteFiles) }));
      await response.body?.cancel().catch(() => undefined);
    },
  };
}
