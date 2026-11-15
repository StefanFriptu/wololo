import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './http.ts';

export interface SpaRuntimeConfig {
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
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Injects window.__WOLOLO__ (API key, URL base) into index.html, like Radarr's initialize.json. */
export function renderIndexHtml(
  template: string,
  config: SpaRuntimeConfig,
): string {
  const script = `<script>window.__WOLOLO__=${escapeJsonForHtml(config)};</script>`;
  return template.includes('</head>')
    ? template.replace('</head>', `${script}</head>`)
    : `${script}${template}`;
}

export function resolveStaticPath(
  webDir: string,
  requestPath: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = normalize(webDir);
  const candidate = normalize(join(root, decoded));
  if (
    candidate !== root &&
    !candidate.startsWith(root.endsWith(sep) ? root : root + sep)
  )
    return null;
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
}): MiddlewareHandler<AppEnv> {
  const indexPath = join(options.webDir, 'index.html');
  const template = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
    : FALLBACK_HTML;

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const pathname = new URL(c.req.url).pathname;
    const relative = pathname.slice(options.urlBase.length) || '/';
    if (relative.startsWith('/api/')) return next();

    if (relative !== '/' && relative !== '/index.html') {
      const filePath = resolveStaticPath(options.webDir, relative);
      if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        const headers: Record<string, string> = relative.startsWith(
          '/_app/immutable/',
        )
          ? { 'cache-control': 'public, max-age=31536000, immutable' }
          : { 'cache-control': 'no-cache' };
        return new Response(Bun.file(filePath), { headers });
      }
      if (/\.[a-z0-9]+$/i.test(relative)) return c.text('Not found', 404);
    }

    return c.html(renderIndexHtml(template, options.runtimeConfig()), 200, {
      'cache-control': 'no-store',
    });
  };
}
