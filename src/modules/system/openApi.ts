import { z } from 'zod';
import type { RouteSchemas } from '../../api/http.ts';
import type { ErrorCode } from '../../core/errors.ts';
import { type ModuleKey, type RouteMeta, splitRouteKey } from '../../shared/api-routes.ts';
import type { RouteKey } from '../../shared/api-types.ts';
import { type JsonSchema, typeExpressionSchema } from './typeExpressionSchema.ts';

export type OpenApiParameter = {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
  description?: string;
  style?: 'form';
  explode?: boolean;
};

export type OpenApiResponse = {
  description: string;
  content?: Record<string, { schema?: JsonSchema }>;
};

export type OpenApiOperation = {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, OpenApiResponse | { $ref: string }>;
  security?: Record<string, string[]>[];
  /** TypeScript type of the response body as declared in src/shared/api-types.ts. */
  'x-response-type': string;
};

export type OpenApiMethod = 'get' | 'post' | 'put' | 'delete' | 'patch';

export type OpenApiDocument = {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string; license: { name: string; identifier: string } };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  security: Record<string, string[]>[];
  paths: Record<string, Partial<Record<OpenApiMethod, OpenApiOperation>>>;
  components: {
    securitySchemes: Record<string, Record<string, string>>;
    responses: Record<string, OpenApiResponse>;
    schemas: Record<string, JsonSchema>;
  };
};

export interface OpenApiInput {
  version: string;
  urlBase: string;
  routes: { readonly [K in RouteKey]: RouteMeta };
  schemas: ReadonlyMap<RouteKey, RouteSchemas>;
  responseTypes: { readonly [K in RouteKey]: string };
  /** Request content type per route when it is not JSON (multipart uploads). */
  requestContentTypes?: Partial<Record<RouteKey, string>>;
}

export interface OpenApiResult {
  document: OpenApiDocument;
  /** Zod schemas that could not be converted; the document describes them as "any value". */
  warnings: string[];
}

const TAG_DESCRIPTIONS: Readonly<Record<ModuleKey, string>> = {
  core: 'Health, server-sent events, settings and logs',
  'probe-scan': 'Libraries, media files, scans, dry run and scheduled tasks',
  'rules-ffmpeg': 'Device profiles and codecs',
  jobs: 'Queue, jobs, history and recycle bin',
  integrations: 'Radarr, Sonarr, Plex, qBittorrent, path mappings and webhooks',
  bdmv: 'Blu-ray (BDMV/ISO) decisions and disc analysis',
  platform: 'System status, health, backups, restart and API documentation',
};

const SECURITY_SCHEMES = {
  apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  apiKeyQuery: { type: 'apiKey', in: 'query', name: 'apikey' },
  bearer: { type: 'http', scheme: 'bearer' },
} as const;

const ERROR_CODES: Readonly<Record<ErrorCode, true>> = {
  not_found: true,
  validation: true,
  unprocessable: true,
  conflict: true,
  unauthorized: true,
  precondition_failed: true,
  upstream: true,
  not_implemented: true,
  internal: true,
};

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string', enum: Object.keys(ERROR_CODES) },
    message: { type: 'string' },
    details: {},
  },
};

const ERROR_REF = { $ref: '#/components/responses/Error' };
const UNAUTHORIZED_REF = { $ref: '#/components/responses/Unauthorized' };

const PATH_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;

export function toOpenApiPath(path: string): string {
  return path.replace(PATH_PARAM_PATTERN, '{$1}');
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "GET /api/v1/jobs/:id/log" -> "getJobsByIdLog"; "GET /health" -> "getHealth". */
export function operationIdFor(key: RouteKey): string {
  const { method, path } = splitRouteKey(key);
  const words = path
    .split('/')
    .filter((segment) => segment && segment !== 'api' && segment !== 'v1')
    .flatMap((segment) => (segment.startsWith(':') ? ['by', segment.slice(1)] : segment.split(/[^A-Za-z0-9]+/)))
    .filter(Boolean);
  return method.toLowerCase() + words.map(capitalize).join('');
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapRefs(value: unknown, rewrite: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRefs(item, rewrite));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string' ? rewrite(item) : mapRefs(item, rewrite),
    ]),
  );
}

/** Moves local "#" and "#/$defs/*" references of a standalone JSON Schema into components.schemas. */
function embedSchema(raw: JsonSchema, rootName: string, components: Record<string, JsonSchema>): JsonSchema {
  const { $schema: _dialect, $defs, ...root } = raw;
  const defs = isRecord($defs) ? $defs : {};
  const names = new Map(
    Object.keys(defs).map((name) => [name, components[name] === undefined ? name : `${rootName}${capitalize(name)}`]),
  );
  let rootReferenced = false;
  const rewrite = (ref: string): string => {
    if (ref === '#') {
      rootReferenced = true;
      return `#/components/schemas/${rootName}`;
    }
    const defName = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : null;
    const target = defName === null ? undefined : names.get(defName);
    return target === undefined ? ref : `#/components/schemas/${target}`;
  };
  for (const [name, def] of Object.entries(defs)) {
    components[names.get(name) as string] = mapRefs(def, rewrite) as JsonSchema;
  }
  const embedded = mapRefs(root, rewrite) as JsonSchema;
  if (!rootReferenced) return embedded;
  components[rootName] = embedded;
  return { $ref: `#/components/schemas/${rootName}` };
}

interface Converter {
  convert(schema: z.ZodType, rootName: string, where: string): JsonSchema;
  components: Record<string, JsonSchema>;
  warnings: string[];
}

function createConverter(): Converter {
  const components: Record<string, JsonSchema> = {};
  const warnings: string[] = [];
  return {
    components,
    warnings,
    convert: (schema, rootName, where) => {
      try {
        const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
        return embedSchema(raw, rootName, components);
      } catch (error) {
        warnings.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    },
  };
}

function objectParameters(schema: JsonSchema, location: 'path' | 'query', name: string): OpenApiParameter[] {
  const properties = schema.properties;
  if (schema.type !== 'object' || !isRecord(properties)) {
    return [{ name, in: location, required: location === 'path', schema, style: 'form', explode: true }];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([property, propertySchema]) => {
    const parameterSchema = isRecord(propertySchema) ? propertySchema : {};
    const description = typeof parameterSchema.description === 'string' ? parameterSchema.description : undefined;
    return {
      name: property,
      in: location,
      required: location === 'path' || required.has(property),
      schema: parameterSchema,
      ...(description ? { description } : {}),
    };
  });
}

function defaultPathParameter(name: string): OpenApiParameter {
  const schema: JsonSchema = name === 'id' ? { type: 'integer', minimum: 1 } : { type: 'string' };
  return { name, in: 'path', required: true, schema };
}

function pathParameters(path: string, declared: OpenApiParameter[]): OpenApiParameter[] {
  const names = [...path.matchAll(PATH_PARAM_PATTERN)].map((match) => match[1] as string);
  return names.map((name) => declared.find((parameter) => parameter.name === name) ?? defaultPathParameter(name));
}

function successResponse(meta: RouteMeta, typeName: string, refs: Set<string>): Record<string, OpenApiResponse> {
  switch (meta.responseType) {
    case 'json': {
      const { schema, refs: named } = typeExpressionSchema(typeName);
      for (const name of named) refs.add(name);
      return { '200': { description: typeName, content: { 'application/json': { schema } } } };
    }
    case 'empty':
      return { '204': { description: 'No Content' } };
    case 'text':
      return { '200': { description: 'Plain text', content: { 'text/plain': { schema: { type: 'string' } } } } };
    case 'blob':
      return { '200': { description: 'File download', content: { 'application/octet-stream': {} } } };
    case 'html':
      return { '200': { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } };
    case 'sse':
      return {
        '200': { description: 'Server-sent events', content: { 'text/event-stream': { schema: { type: 'string' } } } },
      };
    default: {
      const unreachable: never = meta.responseType;
      throw new Error(`unknown response type ${String(unreachable)}`);
    }
  }
}

/**
 * OpenAPI 3.1 document from the route metadata, the zod schemas registered by route() and the response type
 * names of ApiRoutes. Paths are relative to the URL base, which is the single server entry.
 */
export function buildOpenApiDocument(input: OpenApiInput): OpenApiResult {
  const converter = createConverter();
  const refs = new Set<string>();
  const paths: OpenApiDocument['paths'] = {};

  for (const key of Object.keys(input.routes) as RouteKey[]) {
    const meta = input.routes[key];
    const { method, path } = splitRouteKey(key);
    const operationId = operationIdFor(key);
    const schemas = input.schemas.get(key) ?? {};
    const convert = (schema: z.ZodType, part: string) =>
      converter.convert(schema, `${capitalize(operationId)}${capitalize(part)}`, `${key} ${part}`);

    const declaredPath = schemas.params ? objectParameters(convert(schemas.params, 'params'), 'path', 'params') : [];
    const query = schemas.query ? objectParameters(convert(schemas.query, 'query'), 'query', 'query') : [];
    const parameters = [...pathParameters(path, declaredPath), ...query];
    const contentType = input.requestContentTypes?.[key] ?? 'application/json';
    const responseTypeName = input.responseTypes[key];

    const operation: OpenApiOperation = {
      operationId,
      summary: meta.summary,
      tags: [meta.module],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(schemas.body
        ? { requestBody: { required: true, content: { [contentType]: { schema: convert(schemas.body, 'body') } } } }
        : {}),
      responses: {
        ...successResponse(meta, responseTypeName, refs),
        ...(meta.auth === 'apikey' ? { '401': UNAUTHORIZED_REF } : {}),
        default: ERROR_REF,
      },
      ...(meta.auth === 'none' ? { security: [] } : {}),
      'x-response-type': responseTypeName,
    };
    const openApiPath = toOpenApiPath(path);
    paths[openApiPath] = { ...paths[openApiPath], [method.toLowerCase()]: operation };
  }

  const namedSchemas: Record<string, JsonSchema> = { ApiErrorBody: ERROR_SCHEMA };
  for (const name of [...refs].sort()) {
    namedSchemas[name] ??= {
      title: name,
      description: `TypeScript type ${name} from src/shared (api-types.ts or domain.ts); fields are not expanded here.`,
    };
  }

  const usedTags = new Set(Object.values(input.routes).map((meta) => meta.module));
  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: 'Wololo API',
      version: input.version,
      description:
        'REST API of Wololo. Every /api route needs the API key (Settings > General) as X-Api-Key header, ' +
        '?apikey= query parameter or Bearer token. Request schemas come from the server-side validators; ' +
        'response bodies are named after their TypeScript types in src/shared/api-types.ts.',
      license: { name: 'GPL-3.0-only', identifier: 'GPL-3.0-only' },
    },
    servers: [{ url: input.urlBase || '/' }],
    tags: (Object.keys(TAG_DESCRIPTIONS) as ModuleKey[])
      .filter((name) => usedTags.has(name))
      .map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    security: Object.keys(SECURITY_SCHEMES).map((name) => ({ [name]: [] })),
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      responses: {
        Error: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
        },
        Unauthorized: {
          description: 'Missing or invalid API key',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
        },
      },
      schemas: { ...namedSchemas, ...converter.components },
    },
  };
  return { document, warnings: converter.warnings };
}
