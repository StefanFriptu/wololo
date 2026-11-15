import type { AppContext } from '../../app/context.ts';
import type { PathMappingService } from '../../contracts/integrations.ts';
import { AppError, notFound } from '../../core/errors.ts';
import type { PathMappingInput } from '../../shared/api-types.ts';
import type { PathMapping, PathMappingScope } from '../../shared/domain.ts';
import { mapPath, trimTrailingSeparators } from './path-map.ts';
import {
  deletePathMapping,
  findArrInstance,
  findPathMapping,
  insertPathMapping,
  listPathMappings,
  type PathMappingValues,
  updatePathMapping,
} from './store.ts';

/** Mappings that apply to one instance (instance-specific first, so they win ties) or, for null, the global ones. */
export function applicableMappings(
  mappings: readonly PathMapping[],
  scope: PathMappingScope,
  instanceId: number | null,
): PathMapping[] {
  const ofScope = mappings.filter((mapping) => mapping.scope === scope);
  const specific = instanceId == null ? [] : ofScope.filter((mapping) => mapping.instanceId === instanceId);
  return [...specific, ...ofScope.filter((mapping) => mapping.instanceId == null)];
}

export function createPathMappingService(ctx: AppContext): PathMappingService {
  const validate = (input: PathMappingInput, id: number | null): PathMappingValues => {
    const values: PathMappingValues = {
      scope: input.scope,
      instanceId: input.instanceId ?? null,
      remotePath: trimTrailingSeparators(input.remotePath.trim()),
      localPath: trimTrailingSeparators(input.localPath.trim()),
    };
    if (!values.localPath.startsWith('/')) throw new AppError('validation', 'localPath must be an absolute path');
    if (values.instanceId != null) {
      if (values.scope !== 'radarr' && values.scope !== 'sonarr') {
        throw new AppError('validation', `a ${values.scope} mapping cannot be restricted to an arr instance`);
      }
      const instance = findArrInstance(ctx.db, values.instanceId);
      if (!instance) throw new AppError('unprocessable', `arr instance ${values.instanceId} does not exist`);
      if (instance.kind !== values.scope) {
        throw new AppError('unprocessable', `arr instance ${values.instanceId} is a ${instance.kind} instance`);
      }
    }
    const duplicate = listPathMappings(ctx.db, values.scope).find(
      (mapping) =>
        mapping.id !== id && mapping.instanceId === values.instanceId && mapping.remotePath === values.remotePath,
    );
    if (duplicate) throw new AppError('conflict', `a mapping for ${values.remotePath} already exists`);
    return values;
  };

  const translate = (
    direction: 'toLocal' | 'toRemote',
    { scope, path, instanceId }: { scope: PathMappingScope; path: string; instanceId: number | null },
  ) => {
    const pairs = applicableMappings(listPathMappings(ctx.db, scope), scope, instanceId).map((mapping) =>
      direction === 'toLocal'
        ? { from: mapping.remotePath, to: mapping.localPath }
        : { from: mapping.localPath, to: mapping.remotePath },
    );
    return mapPath(path, pairs);
  };

  return {
    list: async () => listPathMappings(ctx.db),
    create: async (input) => insertPathMapping(ctx.db, validate(input, null)),
    update: async (id, input) => {
      if (!findPathMapping(ctx.db, id)) throw notFound(`path mapping ${id}`);
      return updatePathMapping(ctx.db, { id, values: validate(input, id) });
    },
    remove: async (id) => {
      if (!deletePathMapping(ctx.db, id)) throw notFound(`path mapping ${id}`);
    },
    toLocal: async (scope, remotePath, instanceId) =>
      translate('toLocal', { scope, path: remotePath, instanceId: instanceId ?? null }),
    toRemote: async (scope, localPath, instanceId) =>
      translate('toRemote', { scope, path: localPath, instanceId: instanceId ?? null }),
  };
}
