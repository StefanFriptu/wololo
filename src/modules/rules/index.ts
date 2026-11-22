import type { AppContext } from '../../app/context.ts';
import type { RulesService } from '../../contracts/rules-ffmpeg.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { profileQuery } from '../profiles/profileQuery.ts';
import { checkProfiles, computeRulesKey, planConversion, resolveEffectiveProfile } from './engine.ts';

export function createRulesService(ctx: AppContext): RulesService {
  const query = profileQuery(ctx.db);

  const profilesForLibrary = async (libraryId: number) => {
    if (!query.libraryExists(libraryId)) throw notFound(`library ${libraryId}`);
    return query.assignedToLibrary(libraryId);
  };

  return {
    plan: planConversion,
    resolveProfile: resolveEffectiveProfile,
    rulesKey: computeRulesKey,
    checkProfiles,
    profilesForLibrary,
    effectiveProfileForLibrary: async (libraryId, profileId) => {
      const assigned = await profilesForLibrary(libraryId);
      if (assigned.length === 0) return null;
      if (profileId == null) return resolveEffectiveProfile(assigned);
      const chosen = assigned.find((profile) => profile.id === profileId);
      if (!chosen) throw new AppError('unprocessable', `profile ${profileId} is not assigned to library ${libraryId}`);
      return resolveEffectiveProfile([chosen]);
    },
  };
}
