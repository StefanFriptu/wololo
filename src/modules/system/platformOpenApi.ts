import { routeSchemas } from '../../api/http.ts';
import type { AppConfig } from '../../core/config.ts';
import { API_ROUTE_META } from '../../shared/api-routes.ts';
import { buildOpenApiDocument, type OpenApiResult } from './openApi.ts';
import { RESPONSE_TYPE_NAMES } from './responseTypeNames.ts';

/** The OpenAPI document of this server: every route of API_ROUTE_META plus the zod schemas registered so far. */
export function platformOpenApi(config: Pick<AppConfig, 'version' | 'urlBase'>): OpenApiResult {
  return buildOpenApiDocument({
    version: config.version,
    urlBase: config.urlBase,
    routes: API_ROUTE_META,
    schemas: routeSchemas(),
    responseTypes: RESPONSE_TYPE_NAMES,
    requestContentTypes: { 'POST /api/v1/system/backups/restore': 'multipart/form-data' },
  });
}
