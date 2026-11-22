import { eq } from 'drizzle-orm';
import type { AppContext } from '../../app/context.ts';
import type { ProfileService } from '../../contracts/rules-ffmpeg.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { deviceProfiles } from '../../db/schema.ts';
import type { ProfileInput, ProfileWithUsage } from '../../shared/api-types.ts';
import type { DeviceProfile, DeviceProfileDefinition } from '../../shared/domain.ts';
import { codecCatalog } from './codecCatalog.ts';
import { profileQuery } from './profileQuery.ts';
import { profileTemplates } from './profileTemplates.ts';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameDefinition(a: DeviceProfileDefinition, b: DeviceProfileDefinition): boolean {
  return stableJson(a) === stableJson(b);
}

export function createProfileService(ctx: AppContext): ProfileService {
  const log = ctx.logs.logger('profiles');
  const query = profileQuery(ctx.db);

  const withUsage = (profile: DeviceProfile, libraryIds = query.libraryIdsOf(profile.id)): ProfileWithUsage => ({
    ...profile,
    libraryIds,
  });

  const requireProfile = (id: number): DeviceProfile => {
    const profile = query.byId(id);
    if (!profile) throw notFound(`profile ${id}`);
    return profile;
  };

  const assertNameFree = (name: string, exceptId?: number) => {
    const existing = query.byName(name);
    if (existing && existing.id !== exceptId)
      throw new AppError('conflict', `a profile named "${name}" already exists`);
  };

  const insert = (values: {
    name: string;
    description: string;
    definition: DeviceProfileDefinition;
  }): DeviceProfile => {
    assertNameFree(values.name);
    const [row] = ctx.db.insert(deviceProfiles).values(values).returning().all();
    if (!row) throw new Error(`inserting profile "${values.name}" returned no row`);
    return row;
  };

  const invalidateRules = async (profileId: number) => {
    try {
      await ctx.services.media.invalidateRules({ profileId });
    } catch (error) {
      log.warn('rules invalidation failed; the next scan re-checks these files by rules key', { profileId, error });
    }
  };

  return {
    list: async () => {
      const assignments = query.assignments();
      return query.all().map((profile) =>
        withUsage(
          profile,
          assignments.filter((row) => row.profileId === profile.id).map((row) => row.libraryId),
        ),
      );
    },

    get: async (id) => withUsage(requireProfile(id)),

    create: async (input: ProfileInput) =>
      withUsage(
        insert({
          name: input.name,
          description: input.description ?? '',
          definition: input.definition,
        }),
        [],
      ),

    update: async (id, input) => {
      const existing = requireProfile(id);
      assertNameFree(input.name, id);
      const description = input.description ?? existing.description;
      const definitionChanged = !sameDefinition(existing.definition, input.definition);
      if (!definitionChanged && input.name === existing.name && description === existing.description) {
        return withUsage(existing);
      }
      const [updated] = ctx.db
        .update(deviceProfiles)
        .set({
          name: input.name,
          description,
          definition: input.definition,
          version: definitionChanged ? existing.version + 1 : existing.version,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(deviceProfiles.id, id))
        .returning()
        .all();
      if (!updated) throw notFound(`profile ${id}`);
      if (definitionChanged) {
        log.info('profile definition changed', { profileId: id, version: updated.version });
        await invalidateRules(updated.id);
      }
      return withUsage(updated);
    },

    remove: async (id) => {
      const profile = requireProfile(id);
      const libraryIds = query.libraryIdsOf(id);
      if (libraryIds.length > 0) {
        throw new AppError('conflict', `"${profile.name}" is assigned to ${libraryIds.length} library(ies)`, {
          libraryIds,
        });
      }
      ctx.db.delete(deviceProfiles).where(eq(deviceProfiles.id, id)).run();
      log.info('profile deleted', { profileId: id, name: profile.name });
    },

    clone: async (id, name) => {
      const source = requireProfile(id);
      return withUsage(insert({ name, description: source.description, definition: source.definition }), []);
    },

    codecCatalog,
    templates: profileTemplates,
  };
}
