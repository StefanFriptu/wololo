import { expect, test } from 'bun:test';
import { z } from 'zod';
import { API_ROUTE_META } from '../../shared/api-routes.ts';
import type { RouteKey } from '../../shared/api-types.ts';
import { escapeHtml, renderApiDocsPage } from './apiDocsPage.ts';
import { buildOpenApiDocument } from './openApi.ts';
import { RESPONSE_TYPE_NAMES } from './responseTypeNames.ts';

test.each([
  ['<script>alert("x")</script>', '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'],
  ["a & b's", 'a &amp; b&#39;s'],
  ['plain', 'plain'],
])('escapeHtml - %p', (input, expected) => {
  expect(escapeHtml(input)).toBe(expected);
});

function page(urlBase = '') {
  const schemas = new Map<RouteKey, { body?: z.ZodType }>([
    ['PUT /api/v1/settings/general', { body: z.object({ instanceName: z.string().describe('<b>name</b>') }) }],
  ]);
  return renderApiDocsPage(
    buildOpenApiDocument({
      version: '1.0.0',
      urlBase,
      routes: API_ROUTE_META,
      schemas,
      responseTypes: RESPONSE_TYPE_NAMES,
    }).document,
  );
}

test('renderApiDocsPage - lists every operation once with method and response type', () => {
  const html = page();
  const articles = html.match(/<article /g) ?? [];
  expect(articles).toHaveLength(Object.keys(API_ROUTE_META).length);
  expect(html).toContain('<span class="method delete">DELETE</span> <code>/api/v1/system/backups/{name}</code>');
  expect(html).toContain('<code>Paginated&lt;JobSummary&gt;</code>');
});

test('renderApiDocsPage - marks public routes and escapes schema text', () => {
  const html = page();
  expect(html).toMatch(/<code>\/health<\/code> <span class="badge">no API key<\/span>/);
  expect(html).not.toContain('<b>name</b>');
  expect(html).toContain('&lt;b&gt;name&lt;/b&gt;');
});

test('renderApiDocsPage - shows the URL base and links the JSON document relatively', () => {
  const html = page('/wololo');
  expect(html).toContain('base path <code>/wololo</code>');
  expect(html).toContain('href="openapi.json"');
  expect(html).not.toMatch(/<script|https?:\/\//);
});
