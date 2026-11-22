import type { AppContext } from '../../app/context.ts';
import type { PathMappingService } from '../../contracts/integrations.ts';
import { AppError, notFound } from '../../core/errors.ts';
import type { Db } from '../../db/client.ts';
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

export interface PathTranslator {
  toLocal: (remotePath: string) => string;
  toRemote: (localPath: string) => string;
}

/** Reads the applicable mappings once; use it inside loops that translate many paths. */
export function pathTranslator(
  db: Db,
  { scope, instanceId }: { scope: PathMappingScope; instanceId: number | null },
): PathTranslator {
  const mappings = applicableMappings(listPathMappings(db, scope), scope, instanceId);
  const toLocalPairs = mappings.map((mapping) => ({ from: mapping.remotePath, to: mapping.localPath }));
  const toRemotePairs = mappings.map((mapping) => ({ from: mapping.localPath, to: mapping.remotePath }));
  return {
    toLocal: (remotePath) => mapPath(remotePath, toLocalPairs),
    toRemote: (localPath) => mapPath(localPath, toRemotePairs),
  };
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
      pathTranslator(ctx.db, { scope, instanceId: instanceId ?? null }).toLocal(remotePath),
    toRemote: async (scope, localPath, instanceId) =>
      pathTranslator(ctx.db, { scope, instanceId: instanceId ?? null }).toRemote(localPath),
  };
}
