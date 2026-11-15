import type { OpenApiDocument, OpenApiMethod, OpenApiOperation, OpenApiParameter } from './openApi.ts';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const METHOD_ORDER: readonly OpenApiMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

interface Entry {
  method: OpenApiMethod;
  path: string;
  operation: OpenApiOperation;
}

function schemaLabel(schema: Record<string, unknown>): string {
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').pop() ?? 'object';
  if (typeof schema.type === 'string') return schema.format ? `${schema.type} (${String(schema.format)})` : schema.type;
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(' | ');
  return 'any';
}

function parameterRows(parameters: readonly OpenApiParameter[]): string {
  if (parameters.length === 0) return '';
  const rows = parameters
    .map(
      (parameter) =>
        `<tr><td><code>${escapeHtml(parameter.name)}</code></td><td>${parameter.in}</td>` +
        `<td>${escapeHtml(schemaLabel(parameter.schema))}</td><td>${parameter.required ? 'yes' : 'no'}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Required</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function requestBody(operation: OpenApiOperation): string {
  const [contentType, media] = Object.entries(operation.requestBody?.content ?? {})[0] ?? [];
  if (!contentType || !media) return '';
  return (
    `<details><summary>Request body <code>${escapeHtml(contentType)}</code></summary>` +
    `<pre>${escapeHtml(JSON.stringify(media.schema, null, 2))}</pre></details>`
  );
}

function responseSummary(operation: OpenApiOperation): string {
  const status = Object.keys(operation.responses).find((code) => /^2\d\d$/.test(code)) ?? '200';
  return `<p class="response">Response <code>${status}</code> <code>${escapeHtml(operation['x-response-type'])}</code></p>`;
}

function renderEntry({ method, path, operation }: Entry): string {
  const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
  return (
    `<article id="${escapeHtml(operation.operationId)}">` +
    `<h3><span class="method ${method}">${method.toUpperCase()}</span> <code>${escapeHtml(path)}</code>` +
    `${isPublic ? ' <span class="badge">no API key</span>' : ''}</h3>` +
    `<p>${escapeHtml(operation.summary)}</p>` +
    parameterRows(operation.parameters ?? []) +
    requestBody(operation) +
    responseSummary(operation) +
    '</article>'
  );
}

function entriesByTag(document: OpenApiDocument): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>(document.tags.map((tag) => [tag.name, []]));
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHOD_ORDER) {
      const operation = item[method];
      if (!operation) continue;
      const tag = operation.tags[0] ?? 'other';
      const group = groups.get(tag) ?? [];
      group.push({ method, path, operation });
      groups.set(tag, group);
    }
  }
  return groups;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2329;--muted:#5b6670;--line:#dde3e8;--code:#f2f5f7;--accent:#2f7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#15191d;--fg:#e4e8eb;--muted:#9aa5ae;--line:#2c343b;--code:#1e242a;--accent:#5cc28a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px}h2{margin-top:40px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:0 0 4px;word-break:break-all}article{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
article p{margin:4px 0;color:var(--muted)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--code);padding:10px;border-radius:6px;overflow:auto;max-height:420px}
table{border-collapse:collapse;margin:8px 0;font-size:13px;width:100%}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}
.method{display:inline-block;min-width:62px;text-align:center;border-radius:4px;padding:1px 6px;font-size:12px;color:#fff;background:#56606a}
.get{background:#2f6fb0}.post{background:#2f7d4f}.put{background:#a0702a}.patch{background:#7a55a8}.delete{background:#b03a3a}
.badge{font-size:12px;font-weight:normal;color:var(--accent);border:1px solid var(--accent);border-radius:10px;padding:0 8px}
nav a{margin-right:12px;color:var(--accent)}a{color:var(--accent)}summary{cursor:pointer;color:var(--muted)}
`;

/** Pure: a self-contained HTML reference (no external scripts, works offline) rendered from the OpenAPI document. */
export function renderApiDocsPage(document: OpenApiDocument): string {
  const groups = entriesByTag(document);
  const descriptions = new Map(document.tags.map((tag) => [tag.name, tag.description]));
  const sections = [...groups.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(
      ([tag, entries]) =>
        `<section id="tag-${escapeHtml(tag)}"><h2>${escapeHtml(tag)}</h2>` +
        `<p>${escapeHtml(descriptions.get(tag) ?? '')}</p>${entries.map(renderEntry).join('')}</section>`,
    )
    .join('');
  const nav = [...groups.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([tag]) => `<a href="#tag-${escapeHtml(tag)}">${escapeHtml(tag)}</a>`)
    .join('');
  const server = document.servers[0]?.url ?? '/';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.info.title)} ${escapeHtml(document.info.version)}</title><style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(document.info.title)}</h1>
<p>Version ${escapeHtml(document.info.version)} &middot; OpenAPI ${document.openapi} &middot; base path <code>${escapeHtml(server)}</code></p>
<p>${escapeHtml(document.info.description)}</p>
<p>Machine-readable document: <a href="openapi.json"><code>openapi.json</code></a> (send the API key, e.g. <code>openapi.json?apikey=&lt;key&gt;</code>).</p>
<nav>${nav}</nav>
${sections}
</main></body></html>
`;
}
