import { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { trimTrailingSlashes } from '../../shared/trimTrailingSlashes.ts';
import { type FetchLike, type UpstreamRequest, type UpstreamText, upstreamStatus, upstreamText } from './upstream.ts';

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

const torrentFileSchema = z.object({ name: z.string() });

export type RawTorrent = z.infer<typeof torrentSchema>;

export interface QbittorrentOptions {
  url: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type QbittorrentClient = ReturnType<typeof createQbittorrentClient>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sessionCookie(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  const first = cookies.map((cookie) => cookie.split(';')[0]?.trim()).find((pair) => pair?.includes('='));
  return first ?? null;
}

/** qBittorrent Web API v2 with cookie login; a 403 (expired session) logs in again once. */
export function createQbittorrentClient(options: QbittorrentOptions) {
  const base = trimTrailingSlashes(options.url.trim());
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
    const { response, text } = await upstreamText(
      request('auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: options.username, password: options.password }).toString(),
      }),
    );
    if (text.trim() === 'Fails.')
      throw new AppError('upstream', `${SERVICE} rejected the username or password`, { status: 401 });
    cookie = sessionCookie(response) ?? cookie;
    loggedIn = true;
  };

  const authed = async (path: string, init: Partial<UpstreamRequest> = {}): Promise<string> => {
    if (!loggedIn) await login();
    let answer: UpstreamText;
    try {
      answer = await upstreamText(request(path, init));
    } catch (error) {
      if (upstreamStatus(error) !== 403) throw error;
      await login();
      answer = await upstreamText(request(path, init));
    }
    return answer.text;
  };

  const authedJson = async <T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(parseJson(await authed(path)));
    if (!parsed.success) throw new AppError('upstream', `${SERVICE} ${path.split('?')[0]}: unexpected response`);
    return parsed.data;
  };

  const form = (values: Record<string, string>): Partial<UpstreamRequest> => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  });

  return {
    version: async () => (await authed('app/version')).trim(),
    torrents: async (category: string | null) => {
      const query = category ? `?${new URLSearchParams({ category }).toString()}` : '';
      return authedJson(`torrents/info${query}`, z.array(torrentSchema));
    },
    /** File paths of one torrent, relative to its save path ("/" separated, root folder included when it has one). */
    files: async (hash: string) => {
      const files = await authedJson(
        `torrents/files?${new URLSearchParams({ hash }).toString()}`,
        z.array(torrentFileSchema),
      );
      return files.map((file) => file.name);
    },
    deleteTorrent: async (hash: string, deleteFiles: boolean) => {
      await authed('torrents/delete', form({ hashes: hash, deleteFiles: String(deleteFiles) }));
    },
  };
}
