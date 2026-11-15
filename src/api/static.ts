import { existsSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { AuthenticationMode } from '../shared/settings.ts';
import { type AppEnv, requestIp } from './http.ts';

export interface SpaRuntimeConfig {
  /** "" when the client must enter the key itself (see AuthenticationMode). */
  apiKey: string;
  urlBase: string;
  version: string;
  instanceName: string;
}

const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wololo</title></head>
<body><main style="font-family:system-ui;padding:2rem"><h1>Wololo</h1>
<p>The web UI is not built. Run <code>bun run build</code> and restart.</p></main></body></html>`;

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Injects window.__WOLOLO__ (API key, URL base) into index.html, like Radarr's initialize.json. */
export function renderIndexHtml(template: string, config: SpaRuntimeConfig): string {
  const script = `<script>window.__WOLOLO__=${escapeJsonForHtml(config)};</script>`;
  return template.includes('</head>') ? template.replace('</head>', `${script}</head>`) : `${script}${template}`;
}

/**
 * Pure: makes the built index.html work under a URL base. SvelteKit emits root-absolute asset URLs ("/_app/...",
 * "/favicon.svg") and `base: ""`; both are prefixed so assets, import() and client routing resolve under urlBase.
 */
export function applyUrlBase(template: string, urlBase: string): string {
  if (!urlBase) return template;
  return template
    .replace(/\b(href|src)="\/(?!\/)/g, `$1="${urlBase}/`)
    .replace(/(["'(])\/_app\//g, `$1${urlBase}/_app/`)
    .replace(/\bbase:\s*""/g, `base: ${JSON.stringify(urlBase)}`);
}

function ipv4Parts(address: string): number[] | null {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) !== 4) return null;
  return v4.split('.').map(Number);
}

/** Pure: loopback, RFC 1918, CGNAT (100.64/10), link-local and IPv6 ULA (fc00::/7) / link-local (fe80::/10). */
export function isLocalAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a = -1, b = -1] = v4;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  return lower === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(lower) || /^fe[89ab][0-9a-f]?:/.test(lower);
}

/** Pure: may the SPA receive the API key for this request? Proxied requests never count as local. */
export function shouldExposeApiKey(mode: AuthenticationMode, remoteAddress: string | null, proxied: boolean): boolean {
  if (mode === 'disabled') return true;
  if (mode === 'required') return false;
  return !proxied && remoteAddress !== null && isLocalAddress(remoteAddress);
}

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'] as const;

export function resolveStaticPath(webDir: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = normalize(webDir);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return candidate;
}

/**
 * Serves the built SvelteKit SPA from webDir. Existing files are served directly (immutable caching for
 * _app/immutable), every other GET falls back to index.html so client-side routes work on reload.
 */
export function spaHandler(options: {
  webDir: string;
  urlBase: string;
  runtimeConfig: () => SpaRuntimeConfig;
  authentication: () => AuthenticationMode;
}): MiddlewareHandler<AppEnv> {
  const indexPath = join(options.webDir, 'index.html');
  const template = applyUrlBase(
    existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : FALLBACK_HTML,
    options.urlBase,
  );

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const pathname = new URL(c.req.url).pathname;
    const relative = pathname.slice(options.urlBase.length) || '/';
    if (relative.startsWith('/api/')) return next();

    if (relative !== '/' && relative !== '/index.html') {
      const filePath = resolveStaticPath(options.webDir, relative);
      if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        const headers: Record<string, string> = relative.startsWith('/_app/immutable/')
          ? { 'cache-control': 'public, max-age=31536000, immutable' }
          : { 'cache-control': 'no-cache' };
        return new Response(Bun.file(filePath), { headers });
      }
      if (/\.[a-z0-9]+$/i.test(relative)) return c.text('Not found', 404);
    }

    const config = options.runtimeConfig();
    const proxied = PROXY_HEADERS.some((name) => c.req.header(name) !== undefined);
    const exposeKey = shouldExposeApiKey(options.authentication(), requestIp(c), proxied);
    return c.html(renderIndexHtml(template, exposeKey ? config : { ...config, apiKey: '' }), 200, {
      'cache-control': 'no-store',
    });
  };
}
