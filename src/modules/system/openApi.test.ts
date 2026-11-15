import { afterAll, beforeAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { createTestContext, type TestContext } from '../../../test/helpers/context.ts';
import type { RouteSchemas } from '../../api/http.ts';
import { API_ROUTE_META, type RouteMeta, splitRouteKey } from '../../shared/api-routes.ts';
import type { RouteKey } from '../../shared/api-types.ts';
import {
  buildOpenApiDocument,
  type OpenApiDocument,
  type OpenApiMethod,
  type OpenApiOperation,
  operationIdFor,
  toOpenApiPath,
} from './openApi.ts';
import { RESPONSE_TYPE_NAMES } from './responseTypeNames.ts';

const METHODS: readonly OpenApiMethod[] = ['get', 'post', 'put', 'delete', 'patch'];

function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>(
      (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      document,
    );
}

function collectRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else collectRefs(item, found);
    }
  }
  return found;
}

/** Structural OpenAPI 3.1 checks: the rules a spec validator enforces for the parts this generator produces. */
function openApiProblems(document: OpenApiDocument): string[] {
  const problems: string[] = [];
  if (!/^3\.1\.\d+$/.test(document.openapi)) problems.push(`openapi version ${document.openapi}`);
  if (!document.info.title || !document.info.version) problems.push('info.title and info.version are required');
  for (const ref of collectRefs(document)) {
    if (resolvePointer(document, ref) === undefined) problems.push(`unresolved $ref ${ref}`);
  }
  for (const name of Object.keys(document.components.schemas)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) problems.push(`invalid component name ${name}`);
  }
  const schemes = new Set(Object.keys(document.components.securitySchemes));
  const tags = new Set(document.tags.map((tag) => tag.name));
  const operationIds = new Set<string>();
  const checkSecurity = (security: Record<string, string[]>[] | undefined, where: string) => {
    for (const requirement of security ?? []) {
      for (const name of Object.keys(requirement)) {
        if (!schemes.has(name)) problems.push(`${where}: unknown security scheme ${name}`);
      }
    }
  };
  checkSecurity(document.security, 'root');

  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith('/')) problems.push(`path ${path} must start with /`);
    const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const where = `${method.toUpperCase()} ${path}`;
      if (operationIds.has(operation.operationId)) problems.push(`${where}: duplicate operationId`);
      operationIds.add(operation.operationId);
      for (const tag of operation.tags) if (!tags.has(tag)) problems.push(`${where}: undeclared tag ${tag}`);
      checkSecurity(operation.security, where);
      const parameters = operation.parameters ?? [];
      const keys = parameters.map((parameter) => `${parameter.in}:${parameter.name}`);
      if (new Set(keys).size !== keys.length) problems.push(`${where}: duplicate parameters`);
      const pathParams = parameters.filter((parameter) => parameter.in === 'path');
      for (const parameter of pathParams) {
        if (!parameter.required) problems.push(`${where}: path parameter ${parameter.name} must be required`);
        if (!templateParams.includes(parameter.name)) problems.push(`${where}: ${parameter.name} not in the path`);
      }
      for (const name of templateParams) {
        if (!pathParams.some((parameter) => parameter.name === name)) problems.push(`${where}: ${name} undeclared`);
      }
      const statuses = Object.keys(operation.responses);
      if (statuses.length === 0) problems.push(`${where}: no responses`);
      for (const status of statuses) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(status)) problems.push(`${where}: invalid status ${status}`);
      }
      for (const response of Object.values(operation.responses)) {
        if (!('$ref' in response) && typeof response.description !== 'string')
          problems.push(`${where}: response without description`);
      }
    }
  }
  return problems;
}

function operationOf(document: OpenApiDocument, key: RouteKey): OpenApiOperation {
  const { method, path } = splitRouteKey(key);
  const operation = document.paths[toOpenApiPath(path)]?.[method.toLowerCase() as OpenApiMethod];
  if (!operation)
    throw new Error(`no operation for ${key}; paths: ${Object.keys(document.paths).slice(0, 5).join(', ')}`);
  return operation;
}

let t: TestContext;
let served: OpenApiDocument;

beforeAll(async () => {
  t = createTestContext();
  const response = await t.request('/api/v1/openapi.json');
  expect(response.status).toBe(200);
  served = (await response.json()) as OpenApiDocument;
});

afterAll(() => t.cleanup());

test('openapi.json - is a structurally valid OpenAPI 3.1 document', () => {
  expect(openApiProblems(served)).toEqual([]);
});

test('openapi.json - covers every route of API_ROUTE_META exactly once', () => {
  const keys = Object.keys(API_ROUTE_META) as RouteKey[];
  for (const key of keys) {
    const operation = operationOf(served, key);
    expect(operation.summary).toBe(API_ROUTE_META[key].summary);
    expect(operation.tags).toEqual([API_ROUTE_META[key].module]);
    expect(operation['x-response-type']).toBe(RESPONSE_TYPE_NAMES[key]);
  }
  const operations = Object.values(served.paths).flatMap((item) => METHODS.filter((method) => item[method]));
  expect(operations).toHaveLength(keys.length);
});

test('openapi.json - public routes opt out of the API key, others answer 401', () => {
  for (const key of Object.keys(API_ROUTE_META) as RouteKey[]) {
    const operation = operationOf(served, key);
    if (API_ROUTE_META[key].auth === 'none') {
      expect(operation.security).toEqual([]);
      expect(operation.responses['401']).toBeUndefined();
    } else {
      expect(operation.security).toBeUndefined();
      expect(operation.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' });
    }
  }
  expect(served.security).toEqual([{ apiKeyHeader: [] }, { apiKeyQuery: [] }, { bearer: [] }]);
});

test('openapi.json - uses registered zod schemas for bodies, queries and params', () => {
  const settings = operationOf(served, 'PUT /api/v1/settings/general');
  expect(settings.requestBody?.content['application/json']?.schema).toMatchObject({
    type: 'object',
    properties: { port: { type: 'integer' } },
  });
  const logs = operationOf(served, 'GET /api/v1/system/logs');
  expect(logs.parameters?.map((parameter) => parameter.name)).toEqual(['level', 'module', 'afterId', 'limit']);
  const upload = operationOf(served, 'POST /api/v1/system/backups/restore');
  expect(upload.requestBody?.content['multipart/form-data']?.schema).toMatchObject({
    properties: { file: { type: 'string', format: 'binary' } },
  });
  const download = operationOf(served, 'GET /api/v1/system/backups/:name');
  expect(download.parameters).toEqual([
    { name: 'name', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } },
  ]);
});

test('openapi.json - describes responses by response type', () => {
  expect(operationOf(served, 'GET /api/v1/system/health').responses['200']).toEqual({
    description: 'HealthCheck[]',
    content: {
      'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/HealthCheck' } } },
    },
  });
  expect(operationOf(served, 'DELETE /api/v1/system/backups/:name').responses['204']).toBeDefined();
  expect(Object.keys(operationOf(served, 'GET /api/v1/events').responses['200'] ?? {})).toContain('content');
  expect(served.components.schemas.HealthCheck).toMatchObject({ title: 'HealthCheck' });
  expect(served.components.schemas.ApiErrorBody).toMatchObject({ required: ['error', 'message'] });
});

const META: RouteMeta = { module: 'platform', auth: 'apikey', responseType: 'json', summary: 'Test route' };

function buildFor(key: RouteKey, schemas: RouteSchemas, meta: RouteMeta = META) {
  const routes = { [key]: meta } as unknown as Record<RouteKey, RouteMeta>;
  return buildOpenApiDocument({
    version: '1.2.3',
    urlBase: '/wololo',
    routes,
    schemas: new Map([[key, schemas]]),
    responseTypes: RESPONSE_TYPE_NAMES,
  });
}

test('buildOpenApiDocument - uses the URL base as the server and the version as info.version', () => {
  const { document } = buildFor('GET /api/v1/system/status', {});
  expect(document.servers).toEqual([{ url: '/wololo' }]);
  expect(document.info.version).toBe('1.2.3');
  expect(document.tags.map((tag) => tag.name)).toEqual(['platform']);
});

test('buildOpenApiDocument - path parameters default to integer ids and strings without schemas', () => {
  const { document } = buildFor('GET /api/v1/jobs/:id', {});
  expect(operationOf(document, 'GET /api/v1/jobs/:id').parameters).toEqual([
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
  ]);
});

test('buildOpenApiDocument - recursive and shared zod schemas become components', () => {
  type Node = { name: string; children: Node[] };
  const node: z.ZodType<Node> = z.object({
    name: z.string(),
    get children() {
      return z.array(node);
    },
  });
  const shared = z.object({ a: z.string() }).meta({ id: 'SharedThing' });
  const { document, warnings } = buildFor('POST /api/v1/jobs', {
    body: z.object({ tree: node, x: shared, y: shared }),
  });
  expect(warnings).toEqual([]);
  expect(openApiProblems(document)).toEqual([]);
  expect(document.components.schemas.SharedThing).toMatchObject({ type: 'object' });
  expect(JSON.stringify(document)).not.toContain('#/$defs');
});

test('buildOpenApiDocument - a directly recursive body is hoisted under the operation name', () => {
  type Node = { name: string; children: Node[] };
  const node: z.ZodType<Node> = z.object({
    name: z.string(),
    get children() {
      return z.array(node);
    },
  });
  const { document } = buildFor('POST /api/v1/jobs', { body: node });
  expect(operationOf(document, 'POST /api/v1/jobs').requestBody?.content['application/json']?.schema).toEqual({
    $ref: '#/components/schemas/PostJobsBody',
  });
  expect(openApiProblems(document)).toEqual([]);
});

test('buildOpenApiDocument - non-object query schemas become one form-exploded parameter', () => {
  const { document } = buildFor('GET /api/v1/media', { query: z.record(z.string(), z.string()) });
  expect(operationOf(document, 'GET /api/v1/media').parameters).toMatchObject([
    { name: 'query', in: 'query', required: false, style: 'form', explode: true },
  ]);
});

test('buildOpenApiDocument - unconvertible schemas are reported instead of failing the document', () => {
  const broken = z.lazy((): z.ZodString => {
    throw new Error('boom');
  });
  const { document, warnings } = buildFor('POST /api/v1/jobs', { body: broken });
  expect(warnings).toEqual(['POST /api/v1/jobs body: boom']);
  expect(operationOf(document, 'POST /api/v1/jobs').requestBody?.content['application/json']?.schema).toEqual({});
});

test.each<[RouteKey, string]>([
  ['GET /health', 'getHealth'],
  ['GET /api/v1/jobs/:id/log', 'getJobsByIdLog'],
  ['POST /api/v1/system/backups/:name/restore', 'postSystemBackupsByNameRestore'],
  ['GET /api/v1/openapi.json', 'getOpenapiJson'],
  ['PUT /api/v1/system/tasks/:name', 'putSystemTasksByName'],
])('operationIdFor - %s', (key, expected) => {
  expect(operationIdFor(key)).toBe(expected);
});

test.each([
  ['/api/v1/jobs/:id', '/api/v1/jobs/{id}'],
  ['/api/v1/system/backups/:name/restore', '/api/v1/system/backups/{name}/restore'],
  ['/health', '/health'],
])('toOpenApiPath - %s', (path, expected) => {
  expect(toOpenApiPath(path)).toBe(expected);
});
